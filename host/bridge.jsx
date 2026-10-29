/* FastTracker host adapter. ExtendScript / ES3. UTF-8 BOM required by evalFile. */
// Keep ownership across panel reloads in the same ExtendScript session.
var PontoTrackerState = typeof PontoTrackerState === "object" && PontoTrackerState ? PontoTrackerState : { owned: [] };
var PontoTracker = (function () {
    var TICKS = 254016000000;
    var api = { version: "0.5.1" };

    function quote(value) {
        return '"' + String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\u0000-\u001f\u2028\u2029]/g, function (c) {
            var hex = c.charCodeAt(0).toString(16);
            return "\\u" + ("0000" + hex).slice(-4);
        }) + '"';
    }
    function json(value) {
        var parts = [], i;
        if (value === null || value === undefined) return "null";
        if (typeof value === "string") return quote(value);
        if (typeof value === "number") return isFinite(value) ? String(value) : "null";
        if (typeof value === "boolean") return String(value);
        if (value instanceof Array) {
            for (i = 0; i < value.length; i += 1) parts.push(json(value[i]));
            return "[" + parts.join(",") + "]";
        }
        for (i in value) if (value.hasOwnProperty(i)) parts.push(quote(i) + ":" + json(value[i]));
        return "{" + parts.join(",") + "}";
    }
    // A small JSON parser avoids eval() and does not rely on a host JSON polyfill.
    function parseJSON(text) {
        var at = 0;
        function whitespace() { while (/\s/.test(text.charAt(at)) && at < text.length) at += 1; }
        function read() {
            whitespace();
            var c = text.charAt(at), value, key, match, code;
            if (c === '"') {
                value = ""; at += 1;
                while (at < text.length) {
                    c = text.charAt(at++);
                    if (c === '"') return value;
                    if (c === "\\") {
                        c = text.charAt(at++);
                        if (c === "u") { code = text.substr(at, 4); if (!/^[0-9a-fA-F]{4}$/.test(code)) throw new Error("JSON unicode inválido"); value += String.fromCharCode(parseInt(code, 16)); at += 4; }
                        else if (c === "n") value += "\n";
                        else if (c === "r") value += "\r";
                        else if (c === "t") value += "\t";
                        else if (c === "b") value += "\b";
                        else if (c === "f") value += "\f";
                        else if (c === '"' || c === "\\" || c === "/") value += c;
                        else throw new Error("JSON escape inválido");
                    } else { if (c.charCodeAt(0) < 32) throw new Error("JSON controle inválido"); value += c; }
                }
                throw new Error("JSON string incompleta");
            }
            if (c === "[" || c === "{") {
                var array = c === "[", end = array ? "]" : "}";
                value = array ? [] : {}; at += 1; whitespace();
                if (text.charAt(at) === end) { at += 1; return value; }
                while (true) {
                    if (array) value.push(read());
                    else {
                        whitespace(); if (text.charAt(at) !== '"') throw new Error("JSON chave inválida");
                        key = read(); if (key === "__proto__" || key === "constructor" || key === "prototype") throw new Error("JSON chave proibida");
                        whitespace(); if (text.charAt(at++) !== ":") throw new Error("JSON sem dois pontos"); value[key] = read();
                    }
                    whitespace(); c = text.charAt(at++);
                    if (c === end) return value;
                    if (c !== ",") throw new Error("JSON separador inválido");
                }
            }
            match = /^(true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.substr(at));
            if (!match) throw new Error("JSON valor inválido");
            at += match[0].length;
            // ExtendScript associates chained ?: left-to-right: the old
            // dispatcher turned BOTH booleans into Number("true"/"false")
            // (NaN), causing Paste/Stabilize to reject motionBlur off AND on.
            // Explicit branches work in both the legacy and modern engines.
            if (match[0] === "true") return true;
            if (match[0] === "false") return false;
            if (match[0] === "null") return null;
            return Number(match[0]);
        }
        var result = read(); whitespace(); if (at !== text.length) throw new Error("JSON dados extras"); return result;
    }
    function fail(error, changed) { return json({ ok: false, error: String(error), changed: !!changed }); }
    function sequence() {
        var seq = app.project && app.project.activeSequence;
        if (!seq) throw new Error("Abra uma sequência e selecione um clipe de vídeo.");
        return seq;
    }
    function selectedItems(seq) {
        var found = [], t, c;
        for (t = 0; t < seq.videoTracks.numTracks; t += 1) {
            for (c = 0; c < seq.videoTracks[t].clips.numItems; c += 1) {
                if (seq.videoTracks[t].clips[c].isSelected()) found.push({ clip: seq.videoTracks[t].clips[c], track: seq.videoTracks[t], trackIndex: t });
            }
        }
        if (found.length < 1) throw new Error("Selecione um vídeo, texto, ícone ou gráfico na timeline.");
        for (t = 0; t < found.length; t += 1) if (found[t].track.isLocked()) throw new Error("Desbloqueie a trilha selecionada.");
        return found;
    }
    function selected(seq) {
        var items = selectedItems(seq);
        if (items.length !== 1) throw new Error("Selecione um único vídeo e clique em IMPORTAR.");
        return items[0];
    }
    function findItem(seq, id) {
        var t, c;
        for (t = 0; t < seq.videoTracks.numTracks; t += 1) for (c = 0; c < seq.videoTracks[t].clips.numItems; c += 1) {
            if (String(seq.videoTracks[t].clips[c].nodeId) === String(id)) return { clip: seq.videoTracks[t].clips[c], track: seq.videoTracks[t], trackIndex: t };
        }
        throw new Error("O clipe importado ou destino não está mais nesta sequência. Importe novamente.");
    }
    function aspectRatio(value) {
        if (value === undefined || value === null || value === "") return 1;
        var text = String(value).replace(/,/g, ".").replace(/^\s+|\s+$/g, ""), pair, n;
        if (/square|quadrad/i.test(text)) return 1;
        pair = /^([0-9]+(?:\.[0-9]+)?)\s*[:\/]\s*([0-9]+(?:\.[0-9]+)?)$/.exec(text);
        n = pair ? Number(pair[1]) / Number(pair[2]) : Number(text);
        if (!isFinite(n) || n <= 0) throw new Error("Proporção de pixels não reconhecida: " + text);
        return n;
    }
    function isMotion(comp) {
        return /(?:^|\.)ADBE Motion$|Vector Motion|VectorMotion/i.test(String(comp.matchName)) || /^(Motion|Movimento|Vector Motion|Movimento vetorial)$/i.test(String(comp.displayName));
    }
    function paramValue(comp, names, fallback, time) {
        var i, prop, name;
        for (i = 0; i < comp.properties.numItems; i += 1) {
            prop = comp.properties[i]; name = String(prop.displayName || "").toLowerCase();
            if (names.test(name)) {
                if (time && prop.isTimeVarying()) return prop.getValueAtTime(time);
                return prop.getValue();
            }
        }
        return fallback;
    }
    function sameValue(a, b) {
        var i;
        if (a instanceof Array || b instanceof Array) {
            if (!(a instanceof Array) || !(b instanceof Array) || a.length !== b.length) return false;
            for (i = 0; i < a.length; i += 1) if (!sameValue(a[i], b[i])) return false;
            return true;
        }
        if (typeof a === "number" && typeof b === "number") return isFinite(a) && isFinite(b) && Math.abs(a - b) < 0.000001;
        return a === b;
    }
    function isGeometryProperty(prop) {
        return /^(position|posi[cç][aã]o|posici[oó]n|anchor point|ponto de ancoragem|punto de anclaje|scale|scale height|scale width|escala|altura da escala|largura da escala|escala de altura|escala de largura|uniform scale|escala uniforme|rotation|rota[cç][aã]o|rotaci[oó]n)$/i.test(String(prop.displayName || ""));
    }
    function sourceMotionMatrix(clip, frameTicks) {
        // A stopwatch left enabled after Reset is NOT necessarily animation.
        // Compare values without disabling it, clearing keys, or touching Motion.
        // Real source animation needs absolute tracked points/full affine mapping;
        // treating it as a single matrix would silently produce incorrect tracks.
        var ci, pi, comp, prop, baseline, keys, k, frame, time, frames;
        frames = Math.ceil((Number(clip.end.ticks) - Number(clip.start.ticks)) / Number(frameTicks) - 0.000001);
        for (ci = 0; ci < clip.components.numItems; ci += 1) {
            comp = clip.components[ci]; if (!isMotion(comp)) continue;
            for (pi = 0; pi < comp.properties.numItems; pi += 1) {
                prop = comp.properties[pi];
                if (!isGeometryProperty(prop) || !prop.isTimeVarying()) continue;
                if (frames > 3600) throw new Error("Este vídeo tem Motion com keyframes e mais de 3600 frames. Use um trecho menor para validar os ajustes com segurança.");
                try {
                    baseline = prop.getValueAtTime(timeAt(clip, 0, frameTicks));
                    keys = prop.getKeys();
                    // Keys outside this clip's visible In/Out do not matter.
                    if (keys && keys.length) for (k = 0; k < keys.length; k += 1) {
                        if (Number(keys[k].ticks) >= Number(clip.inPoint.ticks) && Number(keys[k].ticks) < Number(clip.outPoint.ticks) && !sameValue(baseline, prop.getValueAtKey(keys[k]))) throw new Error("animated");
                    }
                    for (frame = 1; frame < frames; frame += 1) {
                        time = timeAt(clip, frame, frameTicks);
                        if (!sameValue(baseline, prop.getValueAtTime(time))) throw new Error("animated");
                    }
                } catch (motionError) {
                    if (String(motionError).indexOf("animated") >= 0) throw new Error("O Motion deste vídeo tem animação real em " + String(prop.displayName) + ". Ajustes fixos de Position, Scale, Rotation e Anchor são aceitos, inclusive após Reset; animação de Motion na origem ainda não é suportada.");
                    throw new Error("Não foi possível validar os keyframes de " + String(prop.displayName) + " no Motion. Nenhum ajuste do vídeo foi alterado.");
                }
            }
        }
        return motionMatrix(clip, timeAt(clip, 0, frameTicks));
    }
    function motionMatrix(clip, time) {
        var out = [1, 0, 0, 1], i, comp, height, width, uniform, angle, c, s, a, b, d, e;
        for (i = 0; i < clip.components.numItems; i += 1) {
            comp = clip.components[i]; if (!isMotion(comp)) continue;
            height = Number(paramValue(comp, /^(scale|scale height|escala|altura da escala|escala de altura)$/, 100, time)) / 100;
            uniform = paramValue(comp, /^(uniform scale|escala uniforme)$/, true, time);
            width = uniform ? height : Number(paramValue(comp, /^(scale width|largura da escala|escala de largura)$/, height * 100, time)) / 100;
            angle = Number(paramValue(comp, /^(rotation|rotação|rotacao)$/, 0, time)) * Math.PI / 180;
            if (!isFinite(height) || !isFinite(width) || !isFinite(angle) || Math.abs(width * height) < 0.000001) throw new Error("Scale/Rotation do destino está zerado ou ilegível em um frame do tracking.");
            c = Math.cos(angle); s = Math.sin(angle);
            a = c * width; b = -s * height; d = s * width; e = c * height;
            out = [a * out[0] + b * out[2], a * out[1] + b * out[3], d * out[0] + e * out[2], d * out[1] + e * out[3]];
        }
        return out;
    }
    function descriptor(seq, item, tracking) {
        var clip = item.clip, speed = clip.getSpeed(), settings = seq.getSettings(), file, ci, comp;
        if (clip.isSpeedReversed() || !(Math.abs(speed - 1) < 0.0001 || Math.abs(speed - 100) < 0.0001)) throw new Error("Nesta versão, use clipes sem reverso e com velocidade de 100%.");
        if (tracking && (!clip.projectItem || clip.projectItem.isSequence())) throw new Error("Para IMPORTAR, selecione um arquivo de vídeo original na timeline.");
        file = ""; try { file = clip.projectItem.getMediaPath() || ""; } catch (ignoreMediaPath) {}
        if (tracking && (!file || !new File(file).exists)) throw new Error("A mídia original precisa estar online no disco.");
        var seqWidth = Number(settings.videoFrameWidth || seq.frameSizeHorizontal), seqHeight = Number(settings.videoFrameHeight || seq.frameSizeVertical);
        if (!(seqWidth > 0 && seqHeight > 0)) throw new Error("O Premiere não informou o tamanho da sequência.");
        var pixelAspect = aspectRatio(settings.videoPixelAspectRatio), interpretedAspect = null;
        try { interpretedAspect = aspectRatio(clip.projectItem.getFootageInterpretation().pixelAspectRatio); } catch (ignoreInterpretation) {}
        var canvasMedia = !file || /\.(aegraphic|prgraphic|mogrt|aep)$/i.test(file), nested = false, matrix;
        try { nested = clip.projectItem.isSequence(); } catch (ignoreSequence) {}
        if (nested) canvasMedia = true;
        try { if (clip.getMGTComponent()) canvasMedia = true; } catch (ignoreMGT) {}
        var canvasWidth = seqWidth, canvasHeight = seqHeight, canvasPixelAspectRatio = pixelAspect, ns, nestedFound = false;
        if (nested && !tracking) {
            for (ns = 0; ns < app.project.sequences.numSequences; ns += 1) {
                if (app.project.sequences[ns].projectItem && String(app.project.sequences[ns].projectItem.nodeId) === String(clip.projectItem.nodeId)) {
                    canvasWidth = Number(app.project.sequences[ns].frameSizeHorizontal); canvasHeight = Number(app.project.sequences[ns].frameSizeVertical);
                    canvasPixelAspectRatio = aspectRatio(app.project.sequences[ns].getSettings().videoPixelAspectRatio); nestedFound = true; break;
                }
            }
            if (!nestedFound) throw new Error("Não foi possível ler o tamanho da sequência aninhada de destino.");
        }
        for (ci = 0; ci < clip.components.numItems; ci += 1) {
            comp = clip.components[ci];
            if (/Vector Motion|VectorMotion/i.test(String(comp.matchName))) canvasMedia = true;
        }
        matrix = tracking ? sourceMotionMatrix(clip, seq.timebase) : null;
        return {
            project: String(app.project.path || ""), sequence: String(seq.sequenceID), id: String(clip.nodeId), name: String(clip.name),
            track: item.trackIndex, startTicks: String(clip.start.ticks), endTicks: String(clip.end.ticks), inTicks: String(clip.inPoint.ticks), outTicks: String(clip.outPoint.ticks),
            frameTicks: String(seq.timebase), fps: TICKS / Number(seq.timebase), inSeconds: Number(clip.inPoint.seconds),
            duration: (Number(clip.end.ticks) - Number(clip.start.ticks)) / TICKS,
            sequenceWidth: seqWidth, sequenceHeight: seqHeight, sequencePixelAspectRatio: pixelAspect,
            pixelAspectRatio: interpretedAspect, canvasMedia: canvasMedia, canvasWidth: canvasWidth, canvasHeight: canvasHeight, canvasPixelAspectRatio: canvasPixelAspectRatio, nested: nested, motionMatrix: matrix,
            file: file
        };
    }
    function matches(a, b, sourceOnly) {
        // The analysis belongs to media frames, NOT to the effect stack, track,
        // project filename, or placement in the timeline. Save As/moving a clip
        // or inserting an effect must not destroy a valid tracking clipboard.
        var keys = ["sequence", "id", "inTicks", "outTicks", "file", "frameTicks", "sequenceWidth", "sequenceHeight", "sequencePixelAspectRatio", "pixelAspectRatio"], i;
        if (!sourceOnly) { keys.push("startTicks"); keys.push("endTicks"); }
        for (i = 0; i < keys.length; i += 1) if (String(a[keys[i]]) !== String(b[keys[i]])) return false;
        return true;
    }
    function prepareSource(seq, source) {
        var item = findItem(seq, source.id), actual = descriptor(seq, item, false);
        if (!matches(actual, source, true)) throw new Error("O arquivo, In/Out ou formato da sequência mudou desde a análise. Analise esse novo trecho antes de aplicar.");
        actual.motionMatrix = sourceMotionMatrix(item.clip, actual.frameTicks);
        return actual;
    }
    api.capture = function () {
        try { var seq = sequence(); return json({ ok: true, clip: descriptor(seq, selected(seq), true), hostVersion: app.version }); }
        catch (error) { return fail(error, false); }
    };
    api.preparePaste = function (source) {
        try {
            var seq = sequence(), actual = prepareSource(seq, source), items, targets = [], i;
            items = selectedItems(seq);
            for (i = 0; i < items.length; i += 1) if (String(items[i].clip.nodeId) !== String(source.id)) targets.push(descriptor(seq, items[i], false));
            if (!targets.length) throw new Error("Selecione na timeline o texto, ícone ou outro clipe que vai receber o tracking.");
            if (targets.length > 20) throw new Error("Selecione até 20 destinos por PASTE TRACK.");
            return json({ ok: true, source: actual, targets: targets });
        } catch (error) { return fail(error, false); }
    };
    api.prepareStabilize = function (source) {
        try { var actual = prepareSource(sequence(), source); return json({ ok: true, source: actual, targets: [actual] }); }
        catch (error) { return fail(error, false); }
    };
    function findQeClip(seq, item) {
        app.enableQE();
        var qseq = qe.project.getActiveSequence(), qt, qc, i, found = null;
        if (!qseq) throw new Error("O Premiere não disponibilizou a sequência QE.");
        qt = qseq.getVideoTrackAt(item.trackIndex);
        for (i = 0; i < qt.numItems; i += 1) {
            qc = qt.getItemAt(i);
            try {
                if (qc.type === "Clip" && String(qc.start.ticks) === String(item.clip.start.ticks) && String(qc.end.ticks) === String(item.clip.end.ticks)) {
                    if (found) throw new Error("Correspondência ambígua na trilha QE.");
                    found = qc;
                }
            } catch (error) { if (String(error).indexOf("ambígua") >= 0) throw error; }
        }
        if (!found) throw new Error("Não foi possível identificar o clipe no QE desta versão.");
        return found;
    }
    function timeAt(clip, frame, frameTicks) {
        var time = new Time();
        time.ticks = String(Math.round(Number(clip.inPoint.ticks) + frame * Number(frameTicks)));
        return time;
    }
    function localOffsets(payload, target, item, point) {
        if (payload.mode === "stabilize") return [-point.dx, -point.dy];
        var source = payload.sourceSize, sm = payload.source.motionMatrix || [1, 0, 0, 1];
        var sourcePar = payload.source.pixelAspectRatio || source.pixelAspectRatio || 1;
        // FFmpeg and Premiere present metadata-rotated footage upright. The
        // host interpretation still describes encoded pixels; on a quarter
        // turn its horizontal/vertical pixel ratio is inverted. The probe PAR
        // is already upright, so only invert a host interpretation override.
        if (payload.source.pixelAspectRatio && Math.abs(Number(source.rotation || 0)) % 180 === 90) sourcePar = 1 / sourcePar;
        var x = point.dx * source.width * sourcePar, y = point.dy * source.height;
        var sx = sm[0] * x + sm[1] * y, sy = sm[2] * x + sm[3] * y;
        var tm = motionMatrix(item.clip, timeAt(item.clip, point.frame, payload.source.frameTicks)), determinant = tm[0] * tm[3] - tm[1] * tm[2];
        var tx = (tm[3] * sx - tm[1] * sy) / determinant, ty = (-tm[2] * sx + tm[0] * sy) / determinant;
        return [tx / (target.width * (target.pixelAspectRatio || 1)), ty / target.height];
    }
    function isTransform(component) {
        return /^(?:AE\.)?ADBE Geometry\s*2?$/i.test(String(component.matchName || ""));
    }
    function positionProperty(component) {
        var p, i;
        for (i = 0; i < component.properties.numItems; i += 1) {
            p = component.properties[i];
            if (/^(position|posição|posicao|posición|posicion)$/i.test(String(p.displayName || "")) || /Geometry\s*2?-0002$/i.test(String(p.matchName || ""))) return p;
        }
        // Match names are locale-independent; known Adobe layouts use index 1.
        return isTransform(component) ? component.properties[1] : null;
    }
    function plainName(text) {
        return String(text || "").toLowerCase().replace(/[áàâãä]/g, "a").replace(/[éèêë]/g, "e").replace(/[íìîï]/g, "i").replace(/[óòôõö]/g, "o").replace(/[úùûü]/g, "u").replace(/ç/g, "c").replace(/['’]/g, "").replace(/[^a-z0-9]+/g, " ").replace(/^\s+|\s+$/g, "");
    }
    function shutterProperties(component) {
        var angle = [], composition = [], i, prop, label, match;
        for (i = 0; i < component.properties.numItems; i += 1) {
            prop = component.properties[i]; label = plainName(prop.displayName); match = plainName(prop.matchName);
            // Do not guess numeric indices: Geometry/Geometry2 and localized
            // layouts differ. Opaque numeric matchNames alone are insufficient.
            if ((/composi|komposition/.test(label) && /shutter|obturador|obturateur|verschluss/.test(label)) || /composition.*shutter|shutter.*composition/.test(match)) composition.push(prop);
            else if (/^(shutter angle|angulo (do |del )?obturador|angle d obturateur|angle dobturateur|verschlusswinkel)$/.test(label) || /shutter ?angle/.test(match)) angle.push(prop);
        }
        return { angle: angle.length === 1 ? angle[0] : null, composition: composition.length === 1 ? composition[0] : null, ambiguous: angle.length > 1 || composition.length > 1 };
    }
    function configureMotionBlur(component, requested) {
        var result = { requested: requested, applied: false }, props, previousAngle, previousComposition, angleWritten = false, compositionWritten = false, value;
        if (typeof requested !== "boolean") return null;
        props = shutterProperties(component);
        if (!props.angle || props.ambiguous) { result.warning = "O Premiere não expôs os controles de obturador do Transform de forma única. O tracking foi aplicado sem alterar motion blur."; return result; }
        try {
            if (props.angle.isTimeVarying() || (props.composition && props.composition.isTimeVarying())) throw new Error("Os controles de obturador têm animação manual; ela foi preservada.");
            previousAngle = props.angle.getValue();
            if (typeof previousAngle !== "number" || !isFinite(previousAngle)) throw new Error("Ângulo do obturador ilegível.");
            if (props.composition) {
                previousComposition = props.composition.getValue();
                if (typeof previousComposition !== "boolean" && (typeof previousComposition !== "number" || !isFinite(previousComposition))) throw new Error("Opção de obturador da composição ilegível.");
                compositionWritten = true;
                props.composition.setValue(typeof previousComposition === "boolean" ? false : 0, false);
                value = props.composition.getValue();
                if (!(value === false || value === 0)) throw new Error("O Premiere não confirmou o obturador independente.");
            }
            angleWritten = true;
            props.angle.setValue(requested ? 180 : 0, true);
            value = props.angle.getValue();
            if (typeof value !== "number" || Math.abs(value - (requested ? 180 : 0)) > 0.001) throw new Error("O Premiere não confirmou o ângulo do obturador.");
            result.applied = true; result.shutterAngle = value;
        } catch (blurError) {
            // Blur is optional. Failure must not invalidate a good track or
            // modify unrelated properties, and partial settings are restored.
            if (angleWritten) { try { props.angle.setValue(previousAngle, false); } catch (ignoreAngleRestore) {} }
            if (compositionWritten) { try { props.composition.setValue(previousComposition, true); } catch (ignoreCompositionRestore) {} }
            result.warning = "Tracking aplicado, mas o motion blur não pôde ser configurado: " + String(blurError);
        }
        return result;
    }
    function componentKey(component) {
        var names = [], i, p;
        for (i = 0; i < component.properties.numItems; i += 1) {
            p = component.properties[i]; names.push(String(p.matchName || p.displayName || i));
        }
        return String(component.matchName || component.displayName || "") + ":" + names.join("|");
    }
    function componentState(component) {
        var values = [], i, p;
        for (i = 0; i < component.properties.numItems; i += 1) {
            p = component.properties[i];
            try { values.push(p.isTimeVarying() ? positionState(p) : json(p.getValue())); }
            catch (ignoreUnreadable) { values.push("unreadable"); }
        }
        return componentKey(component) + ":" + values.join("|");
    }
    function snapshot(clip) {
        var out = [], i;
        for (i = 0; i < clip.components.numItems; i += 1) out.push({ ref: clip.components[i], key: componentState(clip.components[i]) });
        return out;
    }
    function insertedComponent(clip, before) {
        var i, j, known, candidates = [], allRetained = true, counts = {}, key, comp;
        if (clip.components.numItems !== before.length + 1) throw new Error("O Premiere não confirmou a inclusão do Transform. O tracking continua pronto; tente novamente.");
        // Prefer native object identity, then a multiset diff if the host wraps
        // its objects again. Never assume an effect is appended at the end.
        for (j = 0; j < before.length; j += 1) {
            known = false;
            for (i = 0; i < clip.components.numItems; i += 1) if (clip.components[i] === before[j].ref) known = true;
            if (!known) allRetained = false;
            key = "$" + before[j].key; counts[key] = (counts[key] || 0) + 1;
        }
        for (i = 0; i < clip.components.numItems; i += 1) {
            comp = clip.components[i]; known = false;
            if (allRetained) {
                for (j = 0; j < before.length; j += 1) if (comp === before[j].ref) known = true;
            } else { key = "$" + componentState(comp); if (counts[key]) { counts[key] -= 1; known = true; } }
            if (!known) candidates.push({ component: comp, index: i });
        }
        if (candidates.length !== 1 || !isTransform(candidates[0].component)) {
            var details = [];
            for (i = 0; i < candidates.length; i += 1) details.push(String(candidates[i].component.matchName || candidates[i].component.displayName));
            throw new Error("Efeito retornado pelo Premiere não reconhecido como Transform: " + details.join(", ") + ". O tracking foi preservado.");
        }
        return candidates[0];
    }
    function positionState(position) {
        var keys = position.getKeys(), out = [], i;
        if (keys && keys.length) for (i = 0; i < keys.length; i += 1) out.push(String(keys[i].ticks) + ":" + json(position.getValueAtKey(keys[i])));
        else out.push(json(position.getValue()));
        return out.sort().join(";");
    }
    function ownedEffect(seq, clip, mode) {
        var entries = PontoTrackerState.owned, e, i, j, p, candidates;
        for (i = entries.length - 1; i >= 0; i -= 1) {
            e = entries[i];
            if (e.sequence !== String(seq.sequenceID) || e.id !== String(clip.nodeId) || e.mode !== mode) continue;
            for (j = 0; j < clip.components.numItems; j += 1) if (clip.components[j] === e.component) {
                p = positionProperty(clip.components[j]);
                if (e.state !== undefined && positionState(p) !== e.state) throw new Error("O Transform do tracker recebeu edições manuais. Para preservá-las, não sobrescrevi esse efeito. Remova apenas esse Transform para reaplicar; não é preciso analisar novamente.");
                e.index = j; return e;
            }
            // Some Premiere builds return fresh wrappers for the same native
            // component. In that case require a UNIQUE exact keyframe match.
            candidates = [];
            if (e.state !== undefined) for (j = 0; j < clip.components.numItems; j += 1) {
                if (!isTransform(clip.components[j]) || componentKey(clip.components[j]) !== e.key) continue;
                p = positionProperty(clip.components[j]);
                if (p && positionState(p) === e.state) candidates.push(j);
            }
            if (candidates.length > 1) throw new Error("Há cópias idênticas do Transform do tracker neste clipe. Não alterei nenhuma delas; remova a cópia extra para reaplicar.");
            if (candidates.length === 1) { e.index = candidates[0]; e.component = clip.components[e.index]; return e; }
            // Removed/undone effects are no longer owned; do not touch another
            // Transform merely because it occupies the old numerical index.
            entries.splice(i, 1);
        }
        return null;
    }
    function clearOwnedKeys(position) {
        var keys = position.getKeys(), i;
        if (keys && keys.length) for (i = keys.length - 1; i >= 0; i -= 1) position.removeKey(keys[i]);
    }
    api.applyFromFile = function (filePath) {
        var changed = false, receipts = [], componentIndex = null, owner = null, activePosition = null;
        try {
            var file = new File(filePath), payload, seq, actualSource, targets, item, current, clip, before, effect, component, position, baseline, xUnit, yUnit, points, i, j, time, value, readback, keys, firstFrame, prepared = [], offsets, target, inserted, blur, receipt;
            if (!file.exists || file.length > 8000000) throw new Error("Arquivo de tracking ausente ou grande demais.");
            file.encoding = "UTF-8"; if (!file.open("r")) throw new Error("Não foi possível abrir os dados.");
            var raw = file.read(); file.close(); payload = parseJSON(raw);
            if (payload.mode !== "stabilize" && payload.mode !== "paste") throw new Error("Modo inválido: use PASTE TRACK ou STABILIZE.");
            if (payload.motionBlur !== undefined && typeof payload.motionBlur !== "boolean") throw new Error("Opção de motion blur inválida.");
            seq = sequence(); actualSource = prepareSource(seq, payload.source); payload.source = actualSource;
            targets = payload.targets;
            if (!(targets instanceof Array) || !targets.length || targets.length > 20) throw new Error("Selecione entre 1 e 20 destinos.");
            if (payload.mode === "stabilize" && (targets.length !== 1 || targets[0].target.id !== payload.source.id)) throw new Error("STABILIZE só pode modificar o vídeo importado.");
            if (!payload.sourceSize || !(payload.sourceSize.width > 0 && payload.sourceSize.height > 0)) throw new Error("Dimensões de origem inválidas.");
            // Resolve and preflight every destination before the first mutation.
            for (j = 0; j < targets.length; j += 1) {
                target = targets[j]; item = findItem(seq, target.target.id); current = descriptor(seq, item, false);
                if (!matches(current, target.target, payload.mode === "stabilize")) throw new Error("Um destino mudou durante a preparação. Selecione e tente novamente.");
                if (item.track.isLocked()) throw new Error("Desbloqueie a trilha de destino.");
                if (!(target.width > 0 && target.height > 0 && isFinite(target.width) && isFinite(target.height))) throw new Error("Dimensões do destino inválidas.");
                points = target.points; offsets = [];
                if (!(points instanceof Array) || points.length < 2 || points.length > 3600) throw new Error("Quantidade de keyframes inválida.");
                for (i = 0; i < points.length; i += 1) {
                    if (typeof points[i].frame !== "number" || points[i].frame !== Math.floor(points[i].frame) || points[i].frame < 0 || points[i].frame / current.fps >= current.duration || typeof points[i].dx !== "number" || typeof points[i].dy !== "number" || !isFinite(points[i].dx) || !isFinite(points[i].dy) || Math.abs(points[i].dx) > 2 || Math.abs(points[i].dy) > 2 || (i && points[i].frame <= points[i - 1].frame)) throw new Error("Dados de tracking fora do intervalo do destino.");
                    offsets.push(localOffsets(payload, target, item, points[i]));
                }
                prepared.push({ target: target, item: item, offsets: offsets, owner: ownedEffect(seq, item.clip, payload.mode) });
            }
            effect = null;
            var names = ["Transform", "Transformar", "Transformação", "Transformation", "Transformieren"];
            for (j = 0; j < prepared.length; j += 1) if (!prepared[j].owner) {
                prepared[j].qclip = findQeClip(seq, prepared[j].item);
                if (!effect) for (i = 0; i < names.length && !effect; i += 1) { try { effect = qe.project.getVideoEffectByName(names[i]); } catch (ignoreName) {} }
                if (!effect) throw new Error("O efeito Transform não foi encontrado no Premiere.");
            }
            for (j = 0; j < prepared.length; j += 1) {
                target = prepared[j].target; item = prepared[j].item; points = target.points; offsets = prepared[j].offsets;
                clip = item.clip; firstFrame = points[0].frame; owner = prepared[j].owner; activePosition = null;
                if (!owner) {
                    before = snapshot(clip); changed = true; prepared[j].qclip.addVideoEffect(effect);
                    clip = findItem(seq, target.target.id).clip;
                    inserted = insertedComponent(clip, before); component = inserted.component; componentIndex = inserted.index;
                    owner = { sequence: String(seq.sequenceID), id: String(clip.nodeId), mode: payload.mode, component: component, key: componentKey(component), index: componentIndex };
                    PontoTrackerState.owned.push(owner);
                } else { component = owner.component; componentIndex = owner.index; }
                position = positionProperty(component);
                if (!position) throw new Error("O Premiere não expôs Position no Transform: " + componentKey(component));
                activePosition = position; baseline = owner.baseline || position.getValue();
                if (!(baseline instanceof Array) || baseline.length !== 2 || typeof baseline[0] !== "number" || typeof baseline[1] !== "number" || !isFinite(baseline[0]) || !isFinite(baseline[1]) || !position.areKeyframesSupported()) throw new Error("Formato de Position incompatível com esta versão.");
                if (Math.abs(baseline[0] - 0.5) < 0.01 && Math.abs(baseline[1] - 0.5) < 0.01) { xUnit = 1; yUnit = 1; }
                else if (baseline[0] >= 1 && baseline[1] >= 1 && isFinite(baseline[0]) && isFinite(baseline[1])) { xUnit = baseline[0] * 2; yUnit = baseline[1] * 2; }
                else throw new Error("Unidades de Position não reconhecidas: " + json(baseline) + ". O Transform foi criado sem animação.");
                owner.baseline = baseline; changed = true;
                clearOwnedKeys(position); position.setTimeVarying(true);
                if (firstFrame > 0) { time = timeAt(clip, 0, payload.source.frameTicks); position.addKey(time); position.setValueAtKey(time, baseline, false); }
                for (i = 0; i < points.length; i += 1) {
                    time = timeAt(clip, points[i].frame, payload.source.frameTicks);
                    value = [baseline[0] + offsets[i][0] * xUnit, baseline[1] + offsets[i][1] * yUnit];
                    position.addKey(time); position.setValueAtKey(time, value, i === points.length - 1); position.setInterpolationTypeAtKey(time, 0, i === points.length - 1);
                }
                keys = position.getKeys();
                if (!keys || keys.length !== points.length + (firstFrame > 0 ? 1 : 0)) throw new Error("A contagem de keyframes gravada não bate com o tracking.");
                for (i = 0; i < points.length; i += 1) {
                    time = timeAt(clip, points[i].frame, payload.source.frameTicks); readback = position.getValueAtKey(time);
                    value = [baseline[0] + offsets[i][0] * xUnit, baseline[1] + offsets[i][1] * yUnit];
                    if (!(readback instanceof Array) || readback.length !== 2 || !isFinite(readback[0]) || !isFinite(readback[1]) || Math.abs(readback[0] - value[0]) > 0.00002 * xUnit || Math.abs(readback[1] - value[1]) > 0.00002 * yUnit) throw new Error("O keyframe " + i + " não pôde ser validado no Premiere.");
                }
                blur = configureMotionBlur(component, payload.motionBlur);
                receipt = { id: String(clip.nodeId), name: String(clip.name), keyframes: keys.length, effectIndex: componentIndex };
                if (blur) receipt.motionBlur = blur;
                receipts.push(receipt);
                owner.state = positionState(position); activePosition = null;
            }
            return json({ ok: true, verified: true, rendered: false, targets: receipts });
        } catch (error) {
            // Remember partial writes as well: the next click replaces ONLY
            // this panel's keys instead of stacking another Transform.
            if (owner && activePosition) { try { owner.state = positionState(activePosition); } catch (ignoreState) {} }
            return json({ ok: false, error: String(error), changed: changed, targets: receipts, effectIndex: componentIndex });
        }
    };
    // Exposed only for non-host tests of serialization and validation.
    api._parseJSON = parseJSON; api._json = json; api._aspectRatio = aspectRatio;
    return api;
}());
