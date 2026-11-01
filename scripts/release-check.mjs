#!/usr/bin/env node
// Reproducible, credential-free npm pack/install smoke test and registry comparison.
// NEVER publishes, and never logs npm auth data.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-polygraph-release-check-"));
function run(bin,args,cwd=root) {
  const result = spawnSync(bin,args,{cwd,encoding:"utf8",timeout:120000,maxBuffer:8<<20,
    env:{...process.env,NPM_CONFIG_AUDIT:"false",NPM_CONFIG_FUND:"false"}});
  if(result.status!==0)throw new Error(bin+" "+args.join(" ")+" failed:\n"+String(result.stderr).slice(-3500));
  return result.stdout.trim();
}
try {
  const out=run(process.platform==="win32"?"npm.cmd":"npm",["pack",".","--json","--ignore-scripts","--pack-destination",tmp]);
  const entries=JSON.parse(out);
  if(!Array.isArray(entries) || entries.length!==1)throw Error("Expected one npm tarball from npm pack .; received "+JSON.stringify(entries).slice(0,1500));
  const meta=entries[0];
  const packed=new Set(meta.files.map(x=>x.path));
  const required=["package.json","bin/polygraph.js","src/record.js","src/guard.js","src/safe-config.js","src/shell/record.sh","README.md","LICENSE"];
  for(const f of required)if(!packed.has(f))throw Error("Missing required file in npm package: "+f);
  const unsafe=[...packed].filter(x=>/(?:^|\/)(?:\.git|\.env|\.npmrc|records|secrets|eval-data)(?:\/|$)/i.test(x)||x.endsWith(".bak")||x.endsWith(".jsonl"));
  if(unsafe.length)throw Error("Potentially unsafe package files: "+unsafe.join(", "));
  const tarball=path.join(tmp,meta.filename),installDir=path.join(tmp,"clean-install");
  fs.mkdirSync(installDir);
  run(process.platform==="win32"?"npm.cmd":"npm",["install","--offline","--ignore-scripts","--no-audit","--no-fund","--prefix",installDir,tarball]);
  const cli=path.join(installDir,"node_modules","agent-polygraph","bin","polygraph.js");
  const version=run(process.execPath,[cli,"--version"],installDir);
  if(version!==pkg.version)throw Error("Packed CLI version mismatch, got "+version);
  const demo=run(process.execPath,[cli,"--demo"],installDir);
  if(!demo.includes("agent-polygraph"))throw Error("Packed CLI demo smoke failed");
  const doctor=run(process.execPath,[cli,"doctor","--agent","claude","--claude-dir",path.join(tmp,"missing-claude")],installDir);
  if(!doctor.includes("agent-polygraph doctor"))throw Error("Packed doctor smoke test failed");
  const explain=run(process.execPath,[cli,"explain","--demo","--limit","1"],installDir);
  if(!explain.includes("agent-polygraph explain"))throw Error("Packed explain smoke test failed");
  const summary={package:pkg.name,version:pkg.version,fileCount:packed.size,tarballBytes:fs.statSync(tarball).size,
    sha512:meta.integrity,cleanInstall:true,demo:true,diagnostics:true,gitHubSourceNotAssumedToBePublished:true};
  if(process.env.CHECK_NPM_REGISTRY==="1") {
    try {
      const response=await fetch("https://registry.npmjs.org/"+encodeURIComponent(pkg.name)+"/latest",{signal:AbortSignal.timeout(10000)});
      if(response.status===404)summary.registry={status:"not-publicly-published"};
      else if(response.ok){
        const published=await response.json();
        const publishedRepo=published.repository?.url||published.repository||"";
        summary.registry={status:"published",version:published.version,repository:publishedRepo};
        if(String(publishedRepo).toLowerCase().includes("elechon-pixel/agent-polygraph")===false)
          throw Error("Published npm name belongs to a different or unverified repository; publishing must be stopped");
      } else summary.registry={status:"unverified",httpStatus:response.status};
    } catch (e) {
      if(String(e.message).includes("belongs to a different"))throw e;
      summary.registry={status:"unverified",reason:e?.name||"registry fetch error"};
    }
  }
  console.log(JSON.stringify(summary,null,2));
} finally {
  fs.rmSync(tmp,{recursive:true,force:true});
}
