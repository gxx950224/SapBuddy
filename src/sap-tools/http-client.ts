import axios from "axios"
import { ADTClient, session_types, type ClientOptions, type HttpClient } from "abap-adt-api"
import { HttpClientException } from "abap-adt-api/build/AdtHTTP.js"
import { executionSignal } from "./execution.js"

/** Preserve the SDK's URL and stateless-clone contract when supplying our transport. */
export function createManagedAdtClient(url: string, username: string, password: string | (() => Promise<string>), client: string | undefined, language: string | undefined, options: ClientOptions, clone = false): ADTClient {
  class Managed extends ADTClient {
    private child?: ADTClient
    override get baseUrl() { return url }
    override get statelessClone(): ADTClient {
      if (clone) return this
      return this.child ??= createManagedAdtClient(url, username, password, client, language, options, true)
    }
    override get stateful() { return super.stateful }
    override set stateful(value: session_types) {
      if (clone && value === session_types.stateful) throw new Error("Stateful sessions not allowed in stateless clones")
      super.stateful = value
    }
  }
  return new Managed(createHttpClient(url, options), username, password, client, language, options)
}

/** ADT retains cookies/CSRF handling; this transport adds per-execution cancellation. */
export function createHttpClient(baseURL: string, defaults: ClientOptions): HttpClient {
  const client = axios.create({ baseURL, timeout: defaults.timeout, httpsAgent: defaults.httpsAgent, responseType: "text" })
  return {
    async request(options) {
      const signal = executionSignal()
      signal?.throwIfAborted()
      const convert = (r: { data: unknown; status: number; statusText: string; headers: unknown }) => ({
        body: typeof r.data === "string" ? r.data : JSON.stringify(r.data ?? ""),
        status: r.status, statusText: r.statusText,
        headers: r.headers as Record<string, string>,
      })
      try {
        return convert(await client.request({
          url: options.url, method: options.method || "GET", params: options.qs,
          headers: options.headers, data: options.body, auth: options.auth,
          httpsAgent: options.httpsAgent ?? defaults.httpsAgent,
          timeout: options.timeout ?? defaults.timeout, signal,
        }))
      } catch (error) {
        signal?.throwIfAborted()
        if (axios.isAxiosError(error)) {
          throw new HttpClientException(error.message, error.code, error.response?.status, defaults, options,
            error.response ? convert(error.response) : undefined, error)
        }
        throw error
      }
    },
  }
}
