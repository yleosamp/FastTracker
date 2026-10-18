"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const hostBytes = fs.readFileSync(path.join(__dirname, "../host/bridge.jsx"));
const source = hostBytes.toString("utf8");
function mockedHost({ legacyJSONOrder = false, legacyEncoding = false } = {}) {
  const context = vm.createContext({});
  vm.runInContext(`
    var fileText='', writes=[], T=254016000000, selection=['clip1'], ratio='1:1', baselineById={}, effectMatch='AE.ADBE Geometry', insertAt=null, failWrite=false, additions=0, positionIndex=1, blurAvailable=true, blurLocale='en', blurFailure=false;
    function Time(){this.ticks='0';}
    function File(p){this.exists=true;this.length=fileText.length;this.open=function(){return true};this.read=function(){return fileText};this.close=function(){};}
    function parameter(name,value){return {displayName:name,value:value,varying:false,keys:[],sample:null,getValue:function(){return this.value},setValue:function(v){if(blurFailure&&/Shutter Angle|obturador/.test(this.displayName))return;this.value=v;},isTimeVarying:function(){return this.varying},getValueAtTime:function(t){return this.sample?this.sample(t):this.value},getValueAtKey:function(t){return this.sample?this.sample(t):this.value},getKeys:function(){return this.keys}}}
    function motion(){var p=[parameter('Scale',100),parameter('Scale Width',100),parameter('Uniform Scale',true),parameter('Rotation',0),parameter('Position',[0.5,0.5]),parameter('Anchor Point',[0.5,0.5])];p.numItems=p.length;return {matchName:'AE.ADBE Motion',displayName:'Motion',properties:p};}
    function makeClip(id,start,duration,inside,file){return {nodeId:id,name:id,start:{ticks:String(start*T)},end:{ticks:String((start+duration)*T)},inPoint:{ticks:String(inside*T),seconds:inside},outPoint:{ticks:String((inside+duration)*T)},
      getSpeed:function(){return 1},isSpeedReversed:function(){return false},isSelected:function(){return selection.indexOf(id)>=0},
      projectItem:{isSequence:function(){return false},getMediaPath:function(){return file},getFootageInterpretation:function(){return {pixelAspectRatio:1}}},components:{0:motion(),numItems:1}};}
    var clip=makeClip('clip1',5,2,12,'C:/fixture.mp4'), text=makeClip('text1',5,2,0,''), icon=makeClip('icon1',5,2,8,'C:/icon.png');
    var tracks=[{clips:{0:clip,numItems:1},isLocked:function(){return false}},{clips:{0:text,numItems:1},isLocked:function(){return false}},{clips:{0:icon,numItems:1},isLocked:function(){return false}}];
    var seq={sequenceID:'sequence1',timebase:String(T/30),videoTracks:{0:tracks[0],1:tracks[1],2:tracks[2],numTracks:3},getSettings:function(){return {videoFrameWidth:1920,videoFrameHeight:1080,videoPixelAspectRatio:ratio}}};
    var app={version:'mock',project:{path:'C:/fixture.prproj',activeSequence:seq},enableQE:function(){}};
    function newPosition(id){var stored={},varying=false;return {displayName:'Position',getValue:function(){return baselineById[id]||[0.5,0.5]},areKeyframesSupported:function(){return true},isTimeVarying:function(){return varying},setTimeVarying:function(v){varying=v;if(!v)stored={}},setValue:function(){},addKey:function(t){stored[t.ticks]=null},removeKey:function(t){delete stored[t.ticks]},setValueAtKey:function(t,v){if(failWrite)throw new Error('simulated write failure');stored[t.ticks]=v;writes.push({id:id,ticks:t.ticks,value:v})},setInterpolationTypeAtKey:function(){},getValueAtKey:function(t){return stored[t.ticks]},getKeys:function(){var a=[];for(var k in stored)a.push({ticks:k});return a}};}
    function transform(id){var props=[parameter('Anchor Point',[0.5,0.5]),newPosition(id),parameter('Scale',100),parameter('Rotation',0)];if(positionIndex!==1){var p=props[1];props[1]=props[positionIndex];props[positionIndex]=p;}if(blurAvailable){props.push(parameter(blurLocale==='pt'?'Usar ângulo do obturador da composição':"Use Composition's Shutter Angle",true));props.push(parameter(blurLocale==='pt'?'Ângulo do obturador':'Shutter Angle',0));}props.numItems=props.length;return {matchName:effectMatch,displayName:'Transform',properties:props};}
    var qe={project:{getActiveSequence:function(){return {getVideoTrackAt:function(t){return {numItems:tracks[t].clips.numItems,getItemAt:function(i){var actual=tracks[t].clips[i];return {type:'Clip',start:actual.start,end:actual.end,addVideoEffect:function(){var n=actual.components.numItems,at=insertAt===null?n:insertAt;for(var k=n;k>at;k--)actual.components[k]=actual.components[k-1];actual.components[at]=transform(actual.nodeId);actual.components.numItems++;additions++;}}}}}}},getVideoEffectByName:function(){return {}}}};
  `, context);
  let hostSource = source;
  // Bounded reproduction of the original ExtendScript bug, NOT a full host
  // emulator: chained ?: associates left in Adobe's legacy interpreter.
  // Replacing its original literal dispatcher models that exact evaluation.
  if (legacyJSONOrder) hostSource = hostSource.replace(
    'return match[0] === "true" ? true : match[0] === "false" ? false : match[0] === "null" ? null : Number(match[0]);',
    'return ((match[0] === "true" ? true : match[0] === "false") ? false : match[0] === "null") ? null : Number(match[0]);'
  );
  // Model an ANSI-default loader: the UTF-8 BOM must select UTF-8 before eval.
  if (legacyEncoding) hostSource = hostBytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? hostSource : Buffer.from(hostSource, "utf8").toString("latin1");
  vm.runInContext(hostSource, context);
  return context;
}
function capture(c) { return JSON.parse(vm.runInContext("PontoTracker.capture()", c)); }
function selection(c, ids) { c.selectedJSON = JSON.stringify(ids); vm.runInContext("selection=PontoTracker._parseJSON(selectedJSON)", c); }
function destinations(c, src) { c.sourceJSON = JSON.stringify(src); return JSON.parse(vm.runInContext("PontoTracker.preparePaste(PontoTracker._parseJSON(sourceJSON))", c)); }
function execute(c, payload) { c.fileText = JSON.stringify(payload); return JSON.parse(vm.runInContext("PontoTracker.applyFromFile('job.json')", c)); }
function writes(c) { return JSON.parse(vm.runInContext("PontoTracker._json(writes)", c)); }
const points = [{ frame: 0, dx: 0, dy: 0 }, { frame: 15, dx: 0.1, dy: -0.05 }];
function stabilize(src, p = points) { return { mode: "stabilize", source: src, sourceSize: { width: 1920, height: 1080 }, targets: [{ target: src, width: 1920, height: 1080, pixelAspectRatio: 1, points: p }] }; }

test("Legacy literal-dispatch regression keeps true/false boolean instead of NaN", () => {
  const c = mockedHost({ legacyJSONOrder: true });
  for (const value of [true, false, null, 0, -12.5, 1e-8, "false"]) {
    c.inputText = JSON.stringify(value);
    const actual = vm.runInContext("PontoTracker._parseJSON(inputText)", c);
    assert.equal(typeof actual, typeof value, c.inputText);
    assert.equal(actual, value, c.inputText);
  }
  const nested = { a: [true, false, null, { b: false }], enabled: true, final: false };
  c.inputText = JSON.stringify(nested);
  assert.deepEqual(JSON.parse(vm.runInContext("PontoTracker._json(PontoTracker._parseJSON(inputText))", c)), nested);
});

test("Both application modes accept blur off/on through the legacy JSON dispatch", () => {
  for (const mode of ["paste", "stabilize"]) for (const enabled of [false, true]) for (const locale of ["en", "pt"]) {
    const c = mockedHost({ legacyJSONOrder: true, legacyEncoding: true });
    const src = capture(c).clip; c.blurLocale = locale;
    let target = src;
    if (mode === "paste") { selection(c, ["text1"]); target = destinations(c, src).targets[0]; }
    const payload = { mode, source: src, sourceSize: { width: 1920, height: 1080 }, motionBlur: enabled, targets: [{ target, width: 1920, height: 1080, pixelAspectRatio: 1, points }] };
    const receipt = execute(c, payload);
    assert.equal(receipt.ok, true, mode + "/" + enabled + "/" + locale + ": " + receipt.error);
    assert.equal(receipt.targets[0].keyframes, points.length);
    assert.deepEqual(receipt.targets[0].motionBlur, { requested: enabled, applied: true, shutterAngle: enabled ? 180 : 0 });
    assert.equal(receipt.targets[0].id, mode === "paste" ? "text1" : "clip1");
    assert.equal(c.additions, 1);
  }
});

test("Host UTF-8 signature preserves Portuguese errors in ANSI-default script loaders", () => {
  assert.deepEqual([...hostBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "JSX must have a UTF-8 BOM for the legacy loader");
  const c = mockedHost({ legacyJSONOrder: true, legacyEncoding: true });
  const src = capture(c).clip, payload = stabilize(src); payload.motionBlur = "true";
  const receipt = execute(c, payload);
  assert.equal(receipt.ok, false); assert.equal(receipt.changed, false); assert.equal(c.additions, 0);
  assert.equal(receipt.error, "Error: Opção de motion blur inválida.");
});

test("JSON parser rejects executable/prototype payloads", () => {
  const c = mockedHost();
  for (const value of [{ a: [1, true, null, "Olá\n\u2028"] }, { x: -1e-8 }, []]) {
    c.inputText = JSON.stringify(value);
    assert.deepEqual(JSON.parse(vm.runInContext("PontoTracker._json(PontoTracker._parseJSON(inputText))", c)), value);
  }
  for (const input of ['{"__proto__": {"x":1}}', '({x:1})', '{"x":NaN}', '[]; app.quit()']) {
    c.inputText = input;
    assert.throws(() => vm.runInContext("PontoTracker._parseJSON(inputText)", c));
  }
});
test("Regression: Premiere square pixels in 1:1, 1/1 and decimal forms do not block Import", () => {
  const c = mockedHost();
  for (const value of [1, "1", "1.0", "1:1", "1 / 1", "1,0", "Square Pixels (1.0)"]) {
    c.ratio = value; const result = capture(c);
    assert.equal(result.ok, true, result.error); assert.equal(result.clip.sequencePixelAspectRatio, 1);
  }
  c.ratio = "4:3"; assert.equal(capture(c).clip.sequencePixelAspectRatio, 4 / 3);
});
test("STABILIZE modifies imported source even when a text is currently selected", () => {
  const c = mockedHost(), src = capture(c).clip; selection(c, ["text1"]);
  const receipt = execute(c, stabilize(src));
  assert.equal(receipt.ok, true, receipt.error); assert.equal(receipt.targets[0].id, "clip1");
  assert.equal(vm.runInContext("text.components.numItems", c), 1);
  const data = writes(c);
  assert.equal(Number(data[0].ticks) / 254016000000, 12); assert.equal(Number(data[1].ticks) / 254016000000, 12.5);
  assert.deepEqual(data[1].value, [0.4, 0.55]);
});
test("PASTE TRACK accepts native text without requiring a media file", () => {
  const c = mockedHost(), src = capture(c).clip; selection(c, ["text1"]);
  const prepared = destinations(c, src);
  assert.equal(prepared.ok, true, prepared.error); assert.equal(prepared.targets[0].canvasMedia, true); assert.equal(prepared.targets[0].file, "");
  const receipt = execute(c, { mode: "paste", source: src, sourceSize: { width: 1920, height: 1080 }, targets: [{ target: prepared.targets[0], width: 1920, height: 1080, pixelAspectRatio: 1, points }] });
  assert.equal(receipt.ok, true, receipt.error); assert.equal(receipt.targets[0].id, "text1");
  assert.deepEqual(writes(c)[1].value, [0.6, 0.45]); assert.equal(vm.runInContext("clip.components.numItems", c), 1);
});
test("4K source at 50% transfers screen-space movement to a smaller PNG scaled to 50%", () => {
  const c = mockedHost(); vm.runInContext("clip.components[0].properties[0].value=50;icon.components[0].properties[0].value=50", c);
  const src = capture(c).clip; selection(c, ["icon1"]); const dest = destinations(c, src).targets[0];
  const receipt = execute(c, { mode: "paste", source: src, sourceSize: { width: 3840, height: 2160 }, targets: [{ target: dest, width: 1024, height: 1024, pixelAspectRatio: 1, points }] });
  assert.equal(receipt.ok, true, receipt.error); assert.deepEqual(writes(c)[1].value, [0.875, 0.39453125]);
  assert.equal(Number(writes(c)[0].ticks) / 254016000000, 8);
});
test("Destination rotation is compensated, and source PAR does not scale Y", () => {
  const c = mockedHost(); vm.runInContext("icon.components[0].properties[3].value=90;clip.projectItem.getFootageInterpretation=function(){return {pixelAspectRatio:2}}", c);
  const src = capture(c).clip; selection(c, ["icon1"]); const dest = destinations(c, src).targets[0];
  const receipt = execute(c, { mode: "paste", source: src, sourceSize: { width: 1920, height: 1080 }, targets: [{ target: dest, width: 1920, height: 1080, pixelAspectRatio: 1, points: [{ frame: 0, dx: 0, dy: 0 }, { frame: 15, dx: 0.1, dy: 0 }] }] });
  assert.equal(receipt.ok, true, receipt.error);
  assert.ok(Math.abs(writes(c)[1].value[0] - 0.5) < 1e-9); assert.ok(Math.abs(writes(c)[1].value[1] - (0.5 - 384 / 1080)) < 1e-9);
});

// Metadata orientation is intrinsic to the media, not an extra Motion
// rotation. These payloads use the same upright basis as FFmpeg's autorotate.
const uprightPortrait = { width: 2160, height: 3840, pixelAspectRatio: 1, encodedWidth: 3840, encodedHeight: 2160, rotation: 90 };
const portraitAxes = [{ frame: 0, dx: 0, dy: 0 }, { frame: 1, dx: 0.1, dy: 0 }, { frame: 2, dx: 0, dy: 0.1 }];
function nearPosition(actual, expected) {
  assert.equal(actual.length, 2);
  for (let i = 0; i < 2; i += 1) assert.ok(Math.abs(actual[i] - expected[i]) < 1e-9, JSON.stringify({ actual, expected }));
}

test("Metadata portrait tracking pastes upright X/Y to text without a second rotation", () => {
  const c = mockedHost(); vm.runInContext("clip.components[0].properties[0].value=50", c);
  const src = capture(c).clip; selection(c, ["text1"]); const target = destinations(c, src).targets[0];
  const receipt = execute(c, { mode: "paste", source: src, sourceSize: uprightPortrait, targets: [{ target, width: 1920, height: 1080, pixelAspectRatio: 1, points: portraitAxes }] });
  assert.equal(receipt.ok, true, receipt.error);
  nearPosition(writes(c)[1].value, [0.5 + 108 / 1920, 0.5]);
  nearPosition(writes(c)[2].value, [0.5, 0.5 + 192 / 1080]);
});

test("Metadata portrait source still respects an independent user Motion rotation", () => {
  const c = mockedHost(); vm.runInContext("clip.components[0].properties[0].value=50;clip.components[0].properties[3].value=90", c);
  const src = capture(c).clip; selection(c, ["text1"]); const target = destinations(c, src).targets[0];
  const receipt = execute(c, { mode: "paste", source: src, sourceSize: uprightPortrait, targets: [{ target, width: 1920, height: 1080, pixelAspectRatio: 1, points: portraitAxes }] });
  assert.equal(receipt.ok, true, receipt.error);
  nearPosition(writes(c)[1].value, [0.5, 0.6]);
  nearPosition(writes(c)[2].value, [0.4, 0.5]);
});

test("Metadata portrait stabilize cancels upright normalized motion without swapping axes", () => {
  const c = mockedHost(), src = capture(c).clip;
  const receipt = execute(c, { mode: "stabilize", source: src, sourceSize: uprightPortrait, targets: [{ target: src, width: 2160, height: 3840, pixelAspectRatio: 1, points: portraitAxes }] });
  assert.equal(receipt.ok, true, receipt.error);
  nearPosition(writes(c)[1].value, [0.4, 0.5]);
  nearPosition(writes(c)[2].value, [0.5, 0.4]);
});

test("Quarter-turn source interpretation PAR is inverted once; upright probe fallback is not inverted twice", () => {
  for (const rotation of [90, -90, 270]) for (const hasInterpretation of [true, false]) {
    const c = mockedHost();
    vm.runInContext("clip.projectItem.getFootageInterpretation=function(){" + (hasInterpretation ? "return {pixelAspectRatio:2}" : "throw new Error('unavailable')") + "}", c);
    const src = capture(c).clip; selection(c, ["text1"]); const target = destinations(c, src).targets[0];
    const sourceSize = { ...uprightPortrait, pixelAspectRatio: 0.5, rotation };
    const receipt = execute(c, { mode: "paste", source: src, sourceSize, targets: [{ target, width: 1920, height: 1080, pixelAspectRatio: 1, points: portraitAxes }] });
    assert.equal(receipt.ok, true, receipt.error);
    nearPosition(writes(c)[1].value, [0.5 + 108 / 1920, 0.5]);
    nearPosition(writes(c)[2].value, [0.5, 0.5 + 384 / 1080]);
  }
});

test("Upright portrait bitmap destination uses its displayed dimensions and PAR, including its own Motion", () => {
  for (const rotatedMotion of [false, true]) {
    const c = mockedHost();
    vm.runInContext("clip.components[0].properties[0].value=50;icon.components[0].properties[0].value=50;icon.components[0].properties[3].value=" + (rotatedMotion ? "90" : "0"), c);
    const src = capture(c).clip; selection(c, ["icon1"]); const target = destinations(c, src).targets[0];
    const receipt = execute(c, { mode: "paste", source: src, sourceSize: uprightPortrait, targets: [{ target, width: 1080, height: 1920, pixelAspectRatio: 0.5, encodedWidth: 1920, encodedHeight: 1080, rotation: 90, points: portraitAxes }] });
    assert.equal(receipt.ok, true, receipt.error);
    nearPosition(writes(c)[1].value, rotatedMotion ? [0.5, 0.5 - 216 / 1920] : [0.5 + 216 / 540, 0.5]);
    nearPosition(writes(c)[2].value, rotatedMotion ? [0.5 + 384 / 540, 0.5] : [0.5, 0.5 + 384 / 1920]);
  }
});
test("Pixel-valued Transform points and a delayed reference keep correct time and baseline", () => {
  const c = mockedHost(); vm.runInContext("baselineById.clip1=[960,540]", c);
  const src = capture(c).clip;
  const receipt = execute(c, stabilize(src, [{ frame: 4, dx: 0, dy: 0 }, { frame: 19, dx: 0.1, dy: -0.05 }]));
  assert.equal(receipt.ok, true, receipt.error); assert.equal(receipt.targets[0].keyframes, 3);
  assert.deepEqual(writes(c).at(-1).value, [768, 594]); assert.equal(Number(writes(c)[0].ticks) / 254016000000, 12);
});
test("Stale origin and out-of-range tracking cannot add an effect", () => {
  for (const corruptOrigin of [true, false]) {
    const c = mockedHost(), src = capture(c).clip;
    if (corruptOrigin) vm.runInContext("clip.inPoint.ticks=String(13*T)", c);
    const receipt = execute(c, stabilize(src, corruptOrigin ? points : [{ frame: 0, dx: 0, dy: 0 }, { frame: 200, dx: 0.1, dy: 0 }]));
    assert.equal(receipt.ok, false); assert.equal(receipt.changed, false); assert.equal(vm.runInContext("clip.components.numItems", c), 1);
  }
});
test("Multiple paste targets preflight together before any effect is added", () => {
  const c = mockedHost(), src = capture(c).clip; selection(c, ["text1", "icon1"]);
  const dests = destinations(c, src).targets;
  const targets = dests.map(d => ({ target: d, width: 1920, height: 1080, points }));
  targets[1].points = [{ frame: 0, dx: 0, dy: 0 }, { frame: 300, dx: 0, dy: 0 }];
  const receipt = execute(c, { mode: "paste", source: src, sourceSize: { width: 1920, height: 1080 }, targets });
  assert.equal(receipt.ok, false); assert.equal(receipt.changed, false); assert.equal(vm.runInContext("text.components.numItems", c), 1);
});

test("Transform accepts Geometry/Geometry2 variants and insertion before other effects", () => {
  for (const match of ['AE.ADBE Geometry', 'AE.ADBE Geometry2', 'ADBE Geometry', 'ADBE Geometry 2']) {
    const c = mockedHost(), src = capture(c).clip;
    c.effectMatch = match; c.insertAt = 0; c.positionIndex = 3;
    const receipt = execute(c, stabilize(src));
    assert.equal(receipt.ok, true, receipt.error); assert.equal(receipt.targets[0].effectIndex, 0);
    assert.deepEqual(writes(c).at(-1).value, [0.4, 0.55]);
  }
});
test("Source effects, Save As, a track move and timeline move do not invalidate tracking", () => {
  const c = mockedHost(), src = capture(c).clip;
  vm.runInContext("app.project.path='C:/saved-as.prproj';clip.components[clip.components.numItems++]=transform('clip1');clip.start.ticks=String(7*T);clip.end.ticks=String(9*T);tracks[0].clips.numItems=0;tracks[2].clips[1]=clip;tracks[2].clips.numItems=2", c);
  const receipt = execute(c, stabilize(src));
  assert.equal(receipt.ok, true, receipt.error);
});
test("Retry reuses a partially written tracker effect without reanalysis or stacking", () => {
  const c = mockedHost(), src = capture(c).clip;
  c.failWrite = true;
  const first = execute(c, stabilize(src)); assert.equal(first.ok, false); assert.equal(first.changed, true);
  c.failWrite = false;
  const second = execute(c, stabilize(src)); assert.equal(second.ok, true, second.error);
  assert.equal(c.additions, 1); assert.equal(vm.runInContext('clip.components.numItems', c), 2);
  const third = execute(c, stabilize(src)); assert.equal(third.ok, true, third.error); assert.equal(c.additions, 1);
});
test("Paste after stabilize uses the same analysis; repeated paste updates its own effect only", () => {
  const c = mockedHost(), src = capture(c).clip;
  assert.equal(execute(c, stabilize(src)).ok, true);
  selection(c, ['text1']);
  const target = destinations(c, src).targets[0];
  const payload = { mode: 'paste', source: src, sourceSize: { width: 1920, height: 1080 }, targets: [{ target, width: 1920, height: 1080, points }] };
  assert.equal(execute(c, payload).ok, true); assert.equal(execute(c, payload).ok, true);
  assert.equal(c.additions, 2);
});
test("Existing user Transform animation is preserved while adding an owned tracker effect", () => {
  const c = mockedHost(), src = capture(c).clip;
  vm.runInContext("var userEffect=transform('clip1');clip.components[clip.components.numItems++]=userEffect;var userTime=new Time();userTime.ticks='1';userEffect.properties[1].setTimeVarying(true);userEffect.properties[1].addKey(userTime);userEffect.properties[1].setValueAtKey(userTime,[0.7,0.8])", c);
  assert.equal(execute(c, stabilize(src)).ok, true);
  assert.equal(vm.runInContext('userEffect.properties[1].getKeys().length', c), 1);
  assert.equal(vm.runInContext('userEffect.properties[1].getValueAtKey(userTime)[0]', c), 0.7);
});
test("Reloading the host adapter preserves ownership and does not stack another effect", () => {
  const c = mockedHost(), src = capture(c).clip;
  assert.equal(execute(c, stabilize(src)).ok, true);
  vm.runInContext(source, c);
  assert.equal(execute(c, stabilize(src)).ok, true); assert.equal(c.additions, 1);
});
test("Fresh native component wrappers are matched by unique owned keys, not old index", () => {
  const c = mockedHost(), src = capture(c).clip;
  assert.equal(execute(c, stabilize(src)).ok, true);
  vm.runInContext("var underlying=clip.components;Object.defineProperty(clip,'components',{get:function(){var list={numItems:underlying.numItems};for(var i=0;i<underlying.numItems;i++){var comp=underlying[i];list[i]={matchName:comp.matchName,displayName:comp.displayName,properties:comp.properties};}return list}})", c);
  assert.equal(execute(c, stabilize(src)).ok, true); assert.equal(c.additions, 1);
});
test("Manual edits to the owned animation are never silently overwritten", () => {
  const c = mockedHost(), src = capture(c).clip;
  assert.equal(execute(c, stabilize(src)).ok, true);
  vm.runInContext("var manualTime=new Time();manualTime.ticks=String(12*T);clip.components[1].properties[1].setValueAtKey(manualTime,[0.7,0.8])", c);
  const receipt = execute(c, stabilize(src)); assert.equal(receipt.ok, false); assert.equal(receipt.changed, false);
  assert.match(receipt.error, /edições manuais/); assert.equal(c.additions, 1);
});
test("Insertion diff with fresh wrappers preserves a pre-existing animated Transform", () => {
  const c = mockedHost(), src = capture(c).clip;
  vm.runInContext(`
    var userEffect=transform('clip1'), userTime=new Time();userTime.ticks='1';
    userEffect.properties[1].setTimeVarying(true);userEffect.properties[1].addKey(userTime);userEffect.properties[1].setValueAtKey(userTime,[0.7,0.8]);
    clip.components[clip.components.numItems++]=userEffect;
    var underlying=clip.components;
    Object.defineProperty(clip,'components',{get:function(){var list={numItems:underlying.numItems};for(var i=0;i<underlying.numItems;i++){var comp=underlying[i];list[i]={matchName:comp.matchName,displayName:comp.displayName,properties:comp.properties};}return list}});
    qe.project.getActiveSequence=function(){return {getVideoTrackAt:function(){return {numItems:1,getItemAt:function(){return {type:'Clip',start:clip.start,end:clip.end,addVideoEffect:function(){for(var i=underlying.numItems;i>0;i--)underlying[i]=underlying[i-1];underlying[0]=transform('clip1');underlying.numItems++;additions++}}}}}}};
  `, c);
  const receipt = execute(c, stabilize(src)); assert.equal(receipt.ok, true, receipt.error);
  assert.equal(receipt.targets[0].effectIndex, 0);
  assert.equal(vm.runInContext('userEffect.properties[1].getKeys().length', c), 1);
  assert.equal(vm.runInContext('userEffect.properties[1].getValueAtKey(userTime)[0]', c), 0.7);
});

test("Host exposes FastTracker 0.4.4 without changing its compatible bridge name", () => {
  assert.equal(vm.runInContext("PontoTracker.version", mockedHost()), "0.4.4");
});

test("Static source Position, Anchor, nonuniform Scale and Rotation are accepted and preserved", () => {
  const c = mockedHost();
  vm.runInContext(`
    clip.components[0].properties[0].value=75;
    clip.components[0].properties[1].value=120;
    clip.components[0].properties[2].value=false;
    clip.components[0].properties[3].value=-3.5;
    clip.components[0].properties[4].value=[0.4,0.6];
    clip.components[0].properties[5].value=[0.3,0.2];
    var motionBefore=PontoTracker._json(clip.components[0].properties.map(function(p){return p.value}));
  `, c);
  const imported = capture(c); assert.equal(imported.ok, true, imported.error);
  const receipt = execute(c, stabilize(imported.clip));
  assert.equal(receipt.ok, true, receipt.error);
  assert.equal(vm.runInContext("PontoTracker._json(clip.components[0].properties.map(function(p){return p.value}))===motionBefore", c), true);
  assert.deepEqual(writes(c).at(-1).value, [0.4, 0.55]);
});

test("Regression: Reset leaving Motion stopwatches enabled does not block re-import", () => {
  const c = mockedHost();
  vm.runInContext(`
    var rotation=clip.components[0].properties[3];rotation.value=6;rotation.varying=true;
    rotation.keys=[{ticks:String(12*T)},{ticks:String(13*T)}];
    clip.components[0].properties[4].varying=true;
    clip.components[0].properties[5].varying=true;
  `, c);
  const beforeReset = capture(c); assert.equal(beforeReset.ok, true, beforeReset.error);
  vm.runInContext("rotation.value=0", c);
  const afterReset = capture(c); assert.equal(afterReset.ok, true, afterReset.error);
  assert.deepEqual(afterReset.clip.motionMatrix, [1, 0, 0, 1]);
  assert.equal(execute(c, stabilize(beforeReset.clip)).ok, true);
  assert.equal(vm.runInContext("rotation.varying", c), true);
  assert.equal(vm.runInContext("rotation.keys.length", c), 2);
});

test("Current source rotation is used on Paste even when changed after import", () => {
  const c = mockedHost(), src = capture(c).clip;
  vm.runInContext("clip.components[0].properties[3].value=90", c);
  selection(c, ["icon1"]); const target = destinations(c, src).targets[0];
  const receipt = execute(c, { mode: "paste", source: src, sourceSize: { width: 1920, height: 1080 }, targets: [{ target, width: 1920, height: 1080, points: [{ frame: 0, dx: 0, dy: 0 }, { frame: 15, dx: 0.1, dy: 0 }] }] });
  assert.equal(receipt.ok, true, receipt.error);
  assert.ok(Math.abs(writes(c).at(-1).value[0] - 0.5) < 1e-9);
  assert.ok(Math.abs(writes(c).at(-1).value[1] - (0.5 + 192 / 1080)) < 1e-9);
});

test("Real animated source Motion is rejected read-only, including changes after import", () => {
  for (const propertyIndex of [0, 3, 4, 5]) {
    const c = mockedHost(), src = capture(c).clip;
    c.propertyIndex = propertyIndex;
    vm.runInContext(`
      var p=clip.components[0].properties[propertyIndex];p.varying=true;
      p.sample=function(t){var delta=(Number(t.ticks)/T-12);return propertyIndex<4?p.value+delta:[0.5+delta,0.5]};
    `, c);
    const imported = capture(c); assert.equal(imported.ok, false); assert.match(imported.error, /animação real/);
    const receipt = execute(c, stabilize(src)); assert.equal(receipt.ok, false); assert.equal(receipt.changed, false);
    assert.equal(c.additions, 0); assert.equal(vm.runInContext("p.varying", c), true);
  }
});

test("Equal endpoint values do not hide a source Motion excursion between keys", () => {
  const c = mockedHost();
  vm.runInContext(`
    var p=clip.components[0].properties[3];p.varying=true;
    p.keys=[{ticks:String(12*T)},{ticks:String((12+59/30)*T)}];
    p.sample=function(t){return Math.abs(Number(t.ticks)/T-13)<0.01?10:0};
  `, c);
  const result = capture(c); assert.equal(result.ok, false); assert.match(result.error, /animação real/);
  assert.equal(c.additions, 0);
});

test("Animated target Scale and Rotation are sampled without modifying their keys", () => {
  const c = mockedHost(), src = capture(c).clip;
  vm.runInContext(`
    var p=icon.components[0].properties[3];p.varying=true;p.keys=[{ticks:String(8*T)},{ticks:String(8.5*T)}];
    p.sample=function(t){return (Number(t.ticks)/T-8)*180};
    var scale=icon.components[0].properties[0];scale.varying=true;scale.sample=function(t){return 100+(Number(t.ticks)/T-8)*100};
  `, c);
  selection(c, ["icon1"]); const target = destinations(c, src).targets[0];
  const receipt = execute(c, { mode: "paste", source: src, sourceSize: { width: 1920, height: 1080 }, targets: [{ target, width: 1920, height: 1080, points: [{ frame: 0, dx: 0, dy: 0 }, { frame: 15, dx: 0.1, dy: 0 }] }] });
  assert.equal(receipt.ok, true, receipt.error);
  assert.ok(Math.abs(writes(c).at(-1).value[0] - 0.5) < 1e-9);
  assert.ok(Math.abs(writes(c).at(-1).value[1] - (0.5 - 128 / 1080)) < 1e-9);
  assert.equal(vm.runInContext("p.keys.length", c), 2); assert.equal(vm.runInContext("p.varying&&scale.varying", c), true);
});

test("Zero scale and unreadable varying Motion fail before adding an effect", () => {
  for (const setup of ["clip.components[0].properties[0].value=0", "var p=clip.components[0].properties[3];p.varying=true;p.getValueAtTime=function(){throw new Error('unreadable')}"]) {
    const c = mockedHost(), src = capture(c).clip;
    vm.runInContext(setup, c);
    const receipt = execute(c, stabilize(src));
    assert.equal(receipt.ok, false); assert.equal(receipt.changed, false); assert.equal(c.additions, 0);
  }
});

test("Motion blur resolves English and Portuguese names, reads back, and toggles its own effect", () => {
  for (const locale of ["en", "pt"]) {
    const c = mockedHost(), src = capture(c).clip; c.blurLocale = locale;
    const payload = stabilize(src); payload.motionBlur = true;
    const on = execute(c, payload); assert.equal(on.ok, true, on.error);
    assert.deepEqual(on.targets[0].motionBlur, { requested: true, applied: true, shutterAngle: 180 });
    assert.equal(vm.runInContext("clip.components[1].properties[4].value", c), false);
    payload.motionBlur = false;
    const off = execute(c, payload); assert.equal(off.ok, true, off.error);
    assert.deepEqual(off.targets[0].motionBlur, { requested: false, applied: true, shutterAngle: 0 });
    assert.equal(c.additions, 1);
  }
});

test("Motion blur semantic matchNames work in reordered layouts without numeric assumptions", () => {
  const c = mockedHost(), src = capture(c).clip;
  vm.runInContext(`
    var originalTransform=transform;
    transform=function(id){var effect=originalTransform(id), props=effect.properties, a=props[5], b=props[4];
      a.displayName='Opaque angle';a.matchName='ShutterAngle';b.displayName='Opaque toggle';b.matchName='UseCompositionShutterAngle';
      props[4]=props[2];props[5]=props[3];props[2]=a;props[3]=b;return effect};
  `, c);
  const payload = stabilize(src); payload.motionBlur = true;
  const receipt = execute(c, payload); assert.equal(receipt.ok, true, receipt.error);
  assert.equal(receipt.targets[0].motionBlur.applied, true);
  assert.equal(vm.runInContext("clip.components[1].properties[2].value", c), 180);
  assert.equal(vm.runInContext("clip.components[1].properties[3].value", c), false);
  assert.equal(vm.runInContext("clip.components[1].properties[4].value", c), 100);
});

test("Missing or ambiguous blur controls do not touch any other Transform property", () => {
  for (const ambiguous of [false, true]) {
    const c = mockedHost(), src = capture(c).clip;
    if (!ambiguous) c.blurAvailable = false;
    else vm.runInContext("var originalTransform=transform;transform=function(id){var e=originalTransform(id);e.properties.push(parameter('Shutter Angle',25));e.properties.numItems=e.properties.length;return e}", c);
    const payload = stabilize(src); payload.motionBlur = true;
    const receipt = execute(c, payload); assert.equal(receipt.ok, true, receipt.error);
    assert.equal(receipt.targets[0].motionBlur.applied, false); assert.match(receipt.targets[0].motionBlur.warning, /obturador/);
    assert.deepEqual(writes(c).at(-1).value, [0.4, 0.55]);
    assert.equal(vm.runInContext("clip.components[1].properties[2].value", c), 100);
    assert.equal(vm.runInContext("clip.components[1].properties[3].value", c), 0);
  }
});

test("Unconfirmed blur write restores settings while keeping the valid tracking", () => {
  const c = mockedHost(), src = capture(c).clip;
  vm.runInContext("var originalTransform=transform;transform=function(id){var e=originalTransform(id);e.properties[5].setValue=function(v){if(v!==180)this.value=v};return e}", c);
  const payload = stabilize(src); payload.motionBlur = true;
  const receipt = execute(c, payload); assert.equal(receipt.ok, true, receipt.error);
  assert.equal(receipt.targets[0].motionBlur.applied, false); assert.match(receipt.targets[0].motionBlur.warning, /confirmou/);
  assert.equal(vm.runInContext("clip.components[1].properties[4].value", c), true);
  assert.equal(vm.runInContext("clip.components[1].properties[5].value", c), 0);
  assert.equal(receipt.targets[0].keyframes, 2);
});

test("Manually animated blur controls and pre-existing user effects are preserved", () => {
  const c = mockedHost(), src = capture(c).clip;
  vm.runInContext(`
    var userEffect=transform('clip1');userEffect.properties[5].value=47;clip.components[clip.components.numItems++]=userEffect;
    var originalTransform=transform;transform=function(id){var e=originalTransform(id);e.properties[5].varying=true;e.properties[5].keys=[{ticks:'1'}];return e};
  `, c);
  const payload = stabilize(src); payload.motionBlur = true;
  const receipt = execute(c, payload); assert.equal(receipt.ok, true, receipt.error);
  assert.equal(receipt.targets[0].motionBlur.applied, false); assert.match(receipt.targets[0].motionBlur.warning, /animação manual/);
  assert.equal(vm.runInContext("userEffect.properties[5].value", c), 47);
  assert.equal(vm.runInContext("clip.components[2].properties[5].keys.length", c), 1);
});

test("Invalid motion blur payload is rejected before any mutation", () => {
  const c = mockedHost(), src = capture(c).clip, payload = stabilize(src); payload.motionBlur = "true";
  const receipt = execute(c, payload); assert.equal(receipt.ok, false); assert.equal(receipt.changed, false); assert.equal(c.additions, 0);
});
