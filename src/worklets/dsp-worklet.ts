// GlitchEffect DSP — minimal passthrough (= `suara create` hello-world)。
// input[0] を output[0] にそのまま流すだけ。ここから自分の DSP を育てる
// (= saturation / filter / delay など)。
//
// audio-thread code = tsconfig.worklet.json で型付け (lib は DOM なし + ESNext、
// AudioWorkletProcessor / registerProcessor は @types/audioworklet の global)。
// `?worker&url` で vite が ES module に bundle して addModule に渡す。
class SuaraDsp extends AudioWorkletProcessor {
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0];
    const output = outputs[0];
    for (let ch = 0; ch < output.length; ch++) {
      const inCh = input[ch];
      const outCh = output[ch];
      if (inCh) {
        outCh.set(inCh);
      } else {
        outCh.fill(0); // input 未接続 = 無音
      }
    }
    return true;
  }
}

registerProcessor('suara-dsp', SuaraDsp);

export {};
