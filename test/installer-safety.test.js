import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { install, uninstall } from "../src/guard.js";
import { installShell, uninstallShell, shellScript } from "../src/record.js";
import { readSettings, writeSettings, backupDirectory } from "../src/safe-config.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "apg-installer-"));
test("atomically updates user-owned settings and keeps private recovery backups", () => {
  const folder = tmp();
  const file = path.join(folder,"settings.json");
  const original = '{"model":"existing"}\n';
  fs.writeFileSync(file,original,{mode:0o640});
  const originalMode=fs.statSync(file).mode & 0o777;
  const env=process.env.AGENT_POLYGRAPH_HOME;
  process.env.AGENT_POLYGRAPH_HOME = path.join(folder,"records");
  try {
    const r=writeSettings(file,'{"model":"new"}\n');
    assert.equal(r.changed,true);
    assert.ok(r.backup);
    assert.equal(fs.readFileSync(r.backup,"utf8"),original);
    assert.equal(fs.readFileSync(file,"utf8"),'{"model":"new"}\n');
    if(process.platform!=="win32"){
      assert.equal(fs.statSync(file).mode & 0o777,originalMode);
      assert.equal(fs.statSync(r.backup).mode & 0o777,0o600);
      assert.equal(fs.statSync(backupDirectory()).mode & 0o777,0o700);
    }
    assert.equal(writeSettings(file,'{"model":"new"}\n').changed,false);
  } finally {
    if(env===undefined)delete process.env.AGENT_POLYGRAPH_HOME; else process.env.AGENT_POLYGRAPH_HOME=env;
  }
});

test("refuses to follow symlink when editing settings", {skip:process.platform==="win32"}, () => {
  const folder=tmp(), target=path.join(folder,"victim");
  fs.writeFileSync(target,"precious");
  const link=path.join(folder,"settings.json");
  fs.symlinkSync(target,link);
  assert.throws(()=>writeSettings(link,"overwritten"));
  assert.equal(fs.readFileSync(target,"utf8"),"precious");
});

test("guard hook install/uninstall back up pre-existing JSON and preserve existing hooks", () => {
  const root=tmp(), file=path.join(root,".claude","settings.json");
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file,JSON.stringify({model:"x",hooks:{Stop:[{hooks:[{type:"command",command:"echo existing"}]}]}})+"\n",{mode:0o640});
  const env=process.env.AGENT_POLYGRAPH_HOME;
  process.env.AGENT_POLYGRAPH_HOME=path.join(root,"artifacts");
  try{
    const added=install({agents:["claude"],cwd:root,command:"agent-polygraph guard"})[0];
    assert.equal(added.changed,true);
    assert.ok(added.backup && fs.existsSync(added.backup));
    if(process.platform!=="win32") assert.equal(fs.statSync(file).mode & 0o777,0o640);
    const rm=uninstall({agents:["claude"],cwd:root})[0];
    assert.equal(rm.changed,true);
    assert.ok(rm.backup);
    assert.equal(JSON.parse(fs.readFileSync(file)).hooks.Stop[0].hooks[0].command,"echo existing");
  }finally{
    if(env===undefined)delete process.env.AGENT_POLYGRAPH_HOME; else process.env.AGENT_POLYGRAPH_HOME=env;
  }
});

test("shell installer escapes single quotes, dollar signs and spaces in startup path", {skip:process.platform==="win32"}, () => {
  const home=path.join(tmp(),"odd' name $HOME");
  fs.mkdirSync(home,{recursive:true});
  const oldHome=process.env.HOME, old=process.env.AGENT_POLYGRAPH_HOME;
  process.env.HOME=home;
  process.env.AGENT_POLYGRAPH_HOME=path.join(home,".agent-polygraph");
  try{
    const rc=path.join(home,".bashrc");
    fs.writeFileSync(rc,"alias hello='echo world'\n",{mode:0o640});
    const added=installShell();
    assert.ok(added.rcs.find(x=>x.file===rc)?.changed);
    assert.equal(fs.readFileSync(rc,"utf8").includes("agent-polygraph record"),true);
    const bash=spawnSync("bash",["-ic",'source "$HOME/.bashrc"; printf "%s" "$__apg_entry"'],{
      env:{...process.env,HOME:home},encoding:"utf8",timeout:10000
    });
    assert.equal(bash.status,0,bash.stderr);
    assert.equal(bash.stdout.trim(),fs.realpathSync(fileURLToPath(new URL("../bin/polygraph.js",import.meta.url))));
    const syntax=spawnSync("bash",["-n",rc],{encoding:"utf8"});
    assert.equal(syntax.status,0,syntax.stderr);
    const script=fs.readFileSync(shellScript(),"utf8");
    assert.ok(script.includes("record --shell-event"));
    assert.equal(uninstallShell().rcs.find(x=>x.file===rc)?.changed,true);
    assert.equal(fs.readFileSync(rc,"utf8"),"alias hello='echo world'\n");
    if(process.platform!=="win32")assert.equal(fs.statSync(rc).mode & 0o777,0o640);
  }finally{
    if(oldHome===undefined)delete process.env.HOME; else process.env.HOME=oldHome;
    if(old===undefined)delete process.env.AGENT_POLYGRAPH_HOME; else process.env.AGENT_POLYGRAPH_HOME=old;
  }
});
