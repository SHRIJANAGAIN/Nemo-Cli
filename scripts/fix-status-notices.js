const fs = require("fs")
const path = require("path")

const file = "packages/tui/src/repl/uiHelpers/statusNoticeDefinitions.tsx"
let content = fs.readFileSync(file, "utf8")

// Fix broken identifiers from aggressive rebrand
content = content.replace(/getSktAiLabsApiKeyWithSource/g, "getTrayambakLabsApiKeyWithSource")
content = content.replace(/isSktAiLabsAuthEnabled/g, "isTrayambakLabsAuthEnabled")
content = content.replace(/SktAiLabs/g, "TrayambakLabs")

fs.writeFileSync(file, content)
console.log("Fixed statusNoticeDefinitions.tsx")
