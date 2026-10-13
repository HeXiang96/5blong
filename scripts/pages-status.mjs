/** 查看 5blong 项目的部署状态（临时诊断脚本）。 */
import { readFileSync } from "node:fs";
import path from "node:path";

const configPath = path.join(
  process.env.APPDATA ?? "",
  "xdg.config",
  ".wrangler",
  "config",
  "default.toml",
);
const token = /oauth_token\s*=\s*"([^"]+)"/.exec(readFileSync(configPath, "utf8"))?.[1];
if (!token) throw new Error("没有可用的 oauth_token");

const API = "https://api.cloudflare.com/client/v4";
const headers = { Authorization: `Bearer ${token}` };

const accounts = await (await fetch(`${API}/accounts?per_page=50`, { headers })).json();
const accountId = accounts.result[0].id;

const project = await (await fetch(`${API}/accounts/${accountId}/pages/projects/5blong`, { headers })).json();
console.log("project:", project.result?.name);
console.log("  subdomain:", project.result?.subdomain);
console.log("  domains:", JSON.stringify(project.result?.domains));
console.log("  production_branch:", project.result?.production_branch);
console.log("  latest:", project.result?.latest_deployment?.url, project.result?.latest_deployment?.latest_stage?.status);

const deployments = await (
  await fetch(`${API}/accounts/${accountId}/pages/projects/5blong/deployments?per_page=6`, { headers })
).json();
console.log("\ndeployments:");
for (const item of deployments.result ?? []) {
  const stage = item.latest_stage ?? {};
  console.log(`  ${item.created_on}  env=${item.environment}  ${stage.name}/${stage.status}`);
  console.log(`     ${item.url}  branch=${item.deployment_trigger?.metadata?.branch}`);
  if (stage.status === "failure") console.log(`     stage detail: ${JSON.stringify(stage)}`);
}
