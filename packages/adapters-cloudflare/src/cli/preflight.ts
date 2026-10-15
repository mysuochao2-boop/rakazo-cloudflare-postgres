import { cloudflarePreflight } from "../preflight.js";

const result = cloudflarePreflight(process.env);
for (const warning of result.warnings) process.stderr.write(`warning: ${warning}\n`);
if (result.errors.length > 0) {
  for (const error of result.errors) process.stderr.write(`error: ${error}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Cloudflare deployment configuration is valid.\n");
}
