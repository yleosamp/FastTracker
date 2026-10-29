"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),zlib=require("node:zlib");
const {resolveRuntime}=require("../core.cjs"),P=require("../tools/package.cjs");
test("macOS relative runtime is scoped to installed plugin, including spaces and accents",()=>{
  const value=resolveRuntime({node:"runtime/bin/node",ffmpeg:"runtime/bin/ffmpeg",ffprobe:"runtime/bin/ffprobe"},"/Users/Editor/Pós #1/FastTracker",path.posix);
  assert.equal(value.node,"/Users/Editor/Pós #1/FastTracker/runtime/bin/node");assert.equal(value.ffprobe,"/Users/Editor/Pós #1/FastTracker/runtime/bin/ffprobe");
});
test("legacy Windows absolute runtime and raw mac paths are preserved, not URI encoded",()=>{
  const win={node:"C:\\Program Files\\nodejs\\node.exe",ffmpeg:"D:\\Pós\\ffmpeg.exe",ffprobe:"\\\\server\\share\\ffprobe.exe"};assert.deepEqual(resolveRuntime(win,"C:\\Plugin",path.win32),win);
  const mac={node:"/Library/Private/node",ffmpeg:"/Users/Ação/100% #1/ffmpeg",ffprobe:"/private/ffprobe"};assert.deepEqual(resolveRuntime(mac,"/Plugin",path.posix),mac);
});
test("runtime rejects missing/invalid fields instead of launching the CEP process as a worker",()=>{
  for(const value of [null,{}, {node:"",ffmpeg:"a",ffprobe:"b"},{node:"a\0b",ffmpeg:"a",ffprobe:"b"}])assert.throws(()=>resolveRuntime(value,"/Plugin",path.posix));
});
test("macOS release includes portable JS dependencies but excludes Windows paths, source tests and user data",()=>{
  const files=P.filesForPlatform("macOS");assert.ok(files.includes("INSTALAR.command"));assert.ok(files.includes("node_modules/jpeg-js/LICENSE"));assert.ok(files.some(f=>f.startsWith("node_modules/@techstark/opencv-js/")));
  for(const bad of ["runtime.json","install.ps1","CONTINUAR.md","VALIDACAO.md"])assert.equal(files.includes(bad),false);
  assert.ok(!files.some(f=>f.startsWith("tests/")));assert.ok(!files.some(f=>f.includes(".log")));
});
test("ZIP retains executable Unix mode and LF for the Finder installer, with standard CRC/DEFLATE",()=>{
  const zip=P.makeZip(["INSTALAR.command","LICENSE"]),end=zip.length-22;assert.equal(zip.readUInt32LE(end),0x06054b50);
  const offset=zip.readUInt32LE(end+16);assert.equal(zip.readUInt32LE(offset),0x02014b50);assert.equal(zip.readUInt16LE(offset+4),0x0314);assert.equal(zip.readUInt32LE(offset+38)>>>16,0x81ed);
  const nameLength=zip.readUInt16LE(26),compressedSize=zip.readUInt32LE(18),data=zlib.inflateRawSync(zip.subarray(30+nameLength,30+nameLength+compressedSize));
  assert.equal(data.includes(13),false);assert.equal(P.crc32(data),zip.readUInt32LE(14));assert.ok(data.toString().startsWith("#!/bin/bash\n"));
  assert.equal(P.crc32(Buffer.from("123456789")),0xcbf43926);
});
test("installer verifies pinned binaries before activation, detects native ARM under Rosetta, and uses no global bypass",()=>{
  const s=fs.readFileSync(path.join(__dirname,"../INSTALAR.command"),"utf8");
  assert.ok(s.includes("hw.optional.arm64"));assert.ok(s.includes("shasum -a 256 -c"));assert.ok(s.includes("https://nodejs.org/dist/"));assert.ok(s.includes("9.0.2"));
  assert.ok(s.indexOf('"$STAGE/runtime/bin/ffprobe" -version')<s.indexOf('mv "$DEST" "$BACKUP"'));
  assert.ok(!/spctl\s+--master-disable|curl[^\n]*\|\s*(?:sh|bash)|sudo\s+(?:rm|defaults|installer)/.test(s));assert.ok(s.includes('mv "$BACKUP" "$DEST"'));
  assert.equal((s.match(/(?:SHA|SHA256)=[a-f0-9]{64}/g)||[]).length,6);
});
