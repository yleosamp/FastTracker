"use strict";
// ZIP writer for the explicit runtime allowlist; retains Unix executable bits.
const fs=require("node:fs"),path=require("node:path"),zlib=require("node:zlib");
const root=path.resolve(__dirname,"..");
function crc32(data){let crc=0xffffffff;for(const byte of data){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return(crc^0xffffffff)>>>0;}
function filesForPlatform(platform){
  if(!["Windows","macOS"].includes(platform))throw Error("Invalid platform");
  const inputs=["CSXS","engine","host","licenses","node_modules/@techstark/opencv-js","node_modules/jpeg-js","index.html","styles.css","main.js","core.cjs","updates.cjs","updates-ui.js","package.json","package-lock.json","LICENSE","THIRD-PARTY-NOTICES.md","README.md"];
  inputs.push(...(platform==="macOS"?["INSTALAR.command","LEIA-ME-macOS.txt"]:["INSTALAR.bat","install.ps1"]));
  const files=[];
  function visit(relative){const p=path.join(root,relative),stat=fs.lstatSync(p);if(stat.isSymbolicLink())throw Error("Symlinks are not allowed in release: "+relative);if(stat.isDirectory())for(const name of fs.readdirSync(p).sort())visit(relative+"/"+name);else if(stat.isFile())files.push(relative);}
  inputs.forEach(visit);return files;
}
function makeZip(files){
  const local=[],central=[];let offset=0;
  for(const relative of files){
    if(relative.includes("..")||relative.startsWith("/")||relative.includes("\\"))throw Error("Unsafe archive path");
    const name=Buffer.from("FastTracker/"+relative),data=fs.readFileSync(path.join(root,relative)),compressed=zlib.deflateRawSync(data,{level:9}),crc=crc32(data);
    const head=Buffer.alloc(30);head.writeUInt32LE(0x04034b50);head.writeUInt16LE(20,4);head.writeUInt16LE(0x800,6);head.writeUInt16LE(8,8);head.writeUInt16LE(0x21,12);head.writeUInt32LE(crc,14);head.writeUInt32LE(compressed.length,18);head.writeUInt32LE(data.length,22);head.writeUInt16LE(name.length,26);local.push(head,name,compressed);
    const dir=Buffer.alloc(46);dir.writeUInt32LE(0x02014b50);dir.writeUInt16LE(0x0314,4);dir.writeUInt16LE(20,6);dir.writeUInt16LE(0x800,8);dir.writeUInt16LE(8,10);dir.writeUInt16LE(0x21,14);dir.writeUInt32LE(crc,16);dir.writeUInt32LE(compressed.length,20);dir.writeUInt32LE(data.length,24);dir.writeUInt16LE(name.length,28);dir.writeUInt32LE(((relative.endsWith(".command")?0x81ed:0x81a4)<<16)>>>0,38);dir.writeUInt32LE(offset,42);central.push(dir,name);offset+=head.length+name.length+compressed.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...local,directory,end]);
}
if(require.main===module){
  const index=process.argv.indexOf("--platform"),platform=index<0?"All":process.argv[index+1];if(!["Windows","macOS","All"].includes(platform))throw Error("Use --platform Windows|macOS|All");
  const version=require("../package.json").version,output=path.resolve(root,"../dist");fs.mkdirSync(output,{recursive:true});
  for(const target of platform==="All"?["Windows","macOS"]:[platform]){const file=path.join(output,"FastTracker-"+version+"-"+target+".zip");if(fs.existsSync(file)&&!process.argv.includes("--force"))throw Error("Already exists: "+file);const data=makeZip(filesForPlatform(target));fs.writeFileSync(file,data);console.log(file+" ("+data.length+" bytes)");}
}
module.exports={filesForPlatform,makeZip,crc32};
