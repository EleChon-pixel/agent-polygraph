import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("blind reviewer packet excludes model decisions and labels are scored afterwards", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apg-review-"));
  try {
    const root = path.join(dir,"projects");
    const folder = path.join(root,"-test");
    fs.mkdirSync(folder,{recursive:true});
    const iso = s=>new Date(Date.UTC(2026,9,31,12,0,s)).toISOString();
    const recs = [
      {type:"user",timestamp:iso(0),cwd:"/repo",origin:{kind:"human"},message:{content:"fix this"}},
      {type:"assistant",timestamp:iso(1),cwd:"/repo",message:{content:[{type:"tool_use",id:"a",name:"Edit",input:{file_path:"/repo/src/main.js",old_string:"x",new_string:"y"}}]}},
      {type:"user",timestamp:iso(2),cwd:"/repo",message:{content:[{type:"tool_result",tool_use_id:"a",content:"The file /repo/src/main.js has been updated successfully."}]}},
      {type:"assistant",timestamp:iso(3),cwd:"/repo",message:{content:[{type:"text",text:"Done. All tests pass."}]}},
    ];
    fs.writeFileSync(path.join(folder,"s.jsonl"),recs.map(x=>JSON.stringify(x)).join("\n")+"\n");
    const args = new URL("../scripts/blind-review.mjs",import.meta.url).pathname;
    const output = path.join(dir,"cases.jsonl");
    const prepare = spawnSync(process.execPath,[args,"prepare","--claude-dir",root,"--out",output],{encoding:"utf8"});
    assert.equal(prepare.status,0,prepare.stderr);
    const row = JSON.parse(fs.readFileSync(output,"utf8").trim());
    assert.equal(row.reviewLabel,null);
    assert.equal(row.quote,undefined);
    assert.equal(row.verdict,undefined);
    assert.ok(row.id);
    if(process.platform!=="win32")assert.equal(fs.statSync(output).mode & 0o777,0o600);
    const reviewedFile = path.join(dir,"reviewed.jsonl");
    fs.writeFileSync(reviewedFile,JSON.stringify({...row,reviewLabel:"no-run"})+"\n");
    const scored = spawnSync(process.execPath,[args,"score","--claude-dir",root,"--labels",reviewedFile],{encoding:"utf8"});
    assert.equal(scored.status,0,scored.stderr);
    const result = JSON.parse(scored.stdout);
    assert.equal(result.reviewed,1);
    assert.equal(result.matched,1);
    assert.equal(result.confusion["no-run -> no-run"],1);
  } finally {
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
