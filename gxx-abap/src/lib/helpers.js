/**
 * gxx-abap 公共辅助函数
 */

function jsonOrText(text, jsonObj, jsonFlag) {
  if (jsonFlag) {
    console.log(JSON.stringify(jsonObj, null, 2));
  } else {
    console.log(text);
  }
}

function extractErrMsg(xmlBody) {
  const m = xmlBody.match(/<message[^>]*>([^<]+)/);
  return m ? m[1] : xmlBody.substring(0, 100);
}

function extractSource(xmlBody) {
  if (xmlBody.trim().startsWith('<?xml')) {
    const match = xmlBody.match(/<content[^>]*>([\s\S]*?)<\/content>/);
    if (match) {
      return match[1]
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'");
    }
  }
  return xmlBody;
}

/**
 * 自动发现函数模块所属的函数组名
 * @param {string} fmName - 函数模块名
 * @param {object} client - ADT client 实例
 * @returns {Promise<string|null>} 函数组名
 */
async function discoverFmGroup(fmName, client) {
  const res = await client.request('GET',
    `/sap/bc/adt/repository/informationsystem/executableObjects?query=${encodeURIComponent(fmName)}&maxResults=10`
  );
  const uriMatch = res.body.match(new RegExp(
    `adtcore:uri="/sap/bc/adt/functions/groups/([^/]+)/fmodules/${fmName.toLowerCase()}"[^>]*adtcore:type="FUGR/FF"`,
    'i'
  ));
  const match = uriMatch;
  return match ? match[1] : null;
}

module.exports = { jsonOrText, extractErrMsg, extractSource, discoverFmGroup };
