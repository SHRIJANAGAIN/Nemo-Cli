const fs = require("fs")
const path = require("path")

const file = "packages/tui/src/repl/uiHelpers/statusNoticeDefinitions.tsx"
let content = fs.readFileSync(file, "utf8")

// Fix broken identifiers from aggressive rebrand
content = content.replace(/getSktAiLabsApiKeyWithSource/g, "getNemoLabsApiKeyWithSource")
content = content.replace(/isSktAiLabsAuthEnabled/g, "isNemoLabsAuthEnabled")
content = content.replace(/SktAiLabs/g, "NemoLabs")

fs.writeFileSync(file, content)
console.log("Fixed statusNoticeDefinitions.tsx")
