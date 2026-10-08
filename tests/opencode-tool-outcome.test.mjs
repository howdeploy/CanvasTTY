import assert from "node:assert/strict";
import test from "node:test";
import { toolOutcomeFromOpenCode, sanitizeToolOutcome } from "../src/agent-runtime/runtime-protocol.mjs";

test("OpenCode output contracts distinguish real success, shell failure, interruption and absent task results",()=>{
 const args={command:"sensitive command"};
 const outcome=(value,status)=>toolOutcomeFromOpenCode("bash",args,value,status);
 assert.equal(outcome(undefined),undefined);
 assert.equal(outcome({}).resultClass,"unknown");
 assert.equal(outcome({title:"shell",output:"out",metadata:{exit:0}}).resultClass,"success");
 const failed=outcome({output:"sensitive shell error",metadata:{exit:1}});
 assert.equal(failed.resultClass,"error");assert.match(failed.errorHash,/^[a-f0-9]{64}$/u);assert.equal(failed.outputHash,undefined);
 assert.equal(outcome({output:"partial",metadata:{exit:null}}).resultClass,"unknown");
 assert.equal(outcome({output:"partial",metadata:{}}).resultClass,"unknown");
 const thrown=outcome({error:"sensitive exception",input:args},"error");
 assert.equal(thrown.resultClass,"error");assert.match(thrown.errorHash,/^[a-f0-9]{64}$/u);
 const mcp=toolOutcomeFromOpenCode("mcp_tool",args,{isError:true,content:[{type:"text",text:"sensitive MCP failure"}]});
 assert.equal(mcp.resultClass,"error");assert.match(mcp.errorHash,/^[a-f0-9]{64}$/u);
 assert.equal(toolOutcomeFromOpenCode("mcp_tool",args,{isError:false,content:[{type:"text",text:"ok"}]}).resultClass,"success");
 for(const value of [failed,thrown,mcp]){assert.deepEqual(sanitizeToolOutcome(value),value);assert.ok(!JSON.stringify(value).includes("sensitive"));}
});

test("OpenCode hashes only verified write metadata and bounds completion summaries",()=>{
 const args={filePath:"/private/path",content:"secret"};
 const write=(value,status)=>toolOutcomeFromOpenCode("write",args,value,status);
 assert.equal(write({output:"written",metadata:{filepath:args.filePath}}).changedPathHashes.length,1);
 assert.equal(write({output:"written",metadata:{filediff:{file:args.filePath}}}).changedPathHashes.length,1);
 assert.deepEqual(write({output:"done"}).changedPathHashes,[],"input alone cannot prove a write");
 assert.deepEqual(write({error:"failed",metadata:{filepath:args.filePath}},"error").changedPathHashes,[]);
 const huge=write({output:"secret".repeat(100000),metadata:{filepath:args.filePath}});
 assert.ok(JSON.stringify(huge).length<600);assert.ok(!JSON.stringify(huge).includes("secret"));
});
