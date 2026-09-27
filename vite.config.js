import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: path.join(root, "src/web/public/ui"),
    emptyOutDir: true,
    sourcemap: false,
    cssCodeSplit: false,
    rollupOptions: {
      input: path.join(root, "src/web/ui/main.jsx"),
      output: {
        format: "iife",
        name: "SapBuddyChatBundle",
        entryFileNames: "chat.js",
        assetFileNames: "chat.css",
        inlineDynamicImports: true,
      },
    },
  },
})
