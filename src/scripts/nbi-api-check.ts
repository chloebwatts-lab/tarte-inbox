// Is the Now Book It API key working? Prints counts only, no guest details.
//   node dist/scripts/nbi-api-check.js
import { nbiApiStatus } from "../nbi/api.js"

const s = await nbiApiStatus()
console.log(JSON.stringify(s, null, 2))
process.exit(s.ok ? 0 : 1)
