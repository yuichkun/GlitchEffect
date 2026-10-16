import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// @suara/sdk は **このプロジェクト内に vendoring した** SDK を指す (= src/sdk/、
// self-contained、 外部 repo を参照しない)。import 名を @suara/sdk に揃えるのは、
// 同じ userland コードが web / VST / 実プロダクト（npm の @suara/sdk）でそのまま
// 動くようにするため。alias の向き先はこのプロジェクトの中だけ。
const sdkDir = fileURLToPath(new URL("./src/sdk", import.meta.url));

// dev port は suara.json の devUrl 1 か所が source of truth (= broker も同じ
// suara.json を読む)。port を変える時は suara.json の devUrl だけ直せば vite も
// DAW も同じ値に追従する (= ここに直書きしない)。
const manifest = JSON.parse(
  readFileSync(new URL("./suara.json", import.meta.url), "utf8"),
);
const devPort = Number(new URL(manifest.devUrl).port);

// dev 中に worklet (src/worklets/) を編集したら HMR せず window ごと full-reload する
// 即席プラグイン。AudioWorklet は AudioContext 生成時に addModule で 1 度だけ読まれる
// = HMR で差し替えるには AudioContext を作り直す必要があって複雑なので、まるごと
// reload に倒してシンプルに保つ (= DSP を編集 → 音が変わるのを即聞ける)。
function workletFullReload() {
  return {
    name: "suara-worklet-full-reload",
    handleHotUpdate(ctx) {
      if (ctx.file.includes("/worklets/")) {
        ctx.server.ws.send({ type: "full-reload" });
        return []; // 既定の HMR はスキップ
      }
    },
  };
}

// Suara plugin frontend。SAB (= useMidi / useTransport / useParam) は
// crossOriginIsolated === true 必須なので dev server 全 response に COOP/COEP。
export default defineConfig({
  // 相対 base。出力 asset / worklet が document からの相対で解決するので、root 配信
  // （SuaraShell の 127.0.0.1/）でも subpath 配信（Portal の /p/<id>/）でも動く。
  // = build 時に base を知らなくてよい（publish と build を疎結合にできる）。
  base: "./",
  plugins: [vue(), workletFullReload()],
  // AudioWorklet processor は `?worker&url` で import する (= src/worklets/)。
  // ES module に bundle すると wrapper が付かず addModule() がそのまま読める。
  worker: {
    format: "es",
  },
  resolve: {
    alias: [
      { find: /^@suara\/sdk$/, replacement: `${sdkDir}/index.ts` },
      { find: /^@suara\/sdk\//, replacement: `${sdkDir}/` },
    ],
  },
  server: {
    port: devPort,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});
