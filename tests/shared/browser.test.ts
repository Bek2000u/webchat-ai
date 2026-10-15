import test from "node:test";
import assert from "node:assert/strict";
import { providerCommandSchema, connectionConfigSchema, uploadedFileSchema } from "../../src/shared/contracts.js";

test("extension commands share a strict provider boundary, not arbitrary string messages",()=>{
  assert.deepEqual(providerCommandSchema.parse({action:"setEnabled",provider:"qwen_web",enabled:false}),{action:"setEnabled",provider:"qwen_web",enabled:false});
  for(const value of [{action:"setEnabled",provider:"qwen_web"},{action:"approve",provider:"qwen_web"},{action:"open",provider:"unknown"},{action:"open",provider:"flow",token:"secret"}])assert.equal(providerCommandSchema.safeParse(value).success,false);
  assert.equal(connectionConfigSchema.safeParse({apiOrigin:"http://127.0.0.1:8000",token:"secret"}).success,false);
});
test("API and browser agree on uploaded media metadata",()=>{
  const file={id:"file",url:"http://127.0.0.1:8000/v1/files/file",bytes:42,mimeType:"image/png",sha256:"a".repeat(64)};
  assert.deepEqual(uploadedFileSchema.parse(file),file);
  assert.equal(uploadedFileSchema.safeParse({...file,bytes:-1}).success,false);
  assert.equal(uploadedFileSchema.safeParse({url:file.url}).success,false);
});
