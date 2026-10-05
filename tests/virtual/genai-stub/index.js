import fs from 'node:fs';
const DIR = process.env.STUB_DIR || '/tmp/stub';
export class GoogleGenAI {
  constructor(opts) { this.opts = opts; }
  models = {
    generateContent: async ({ model, contents, config }) => {
      fs.mkdirSync(DIR, { recursive: true });
      fs.appendFileSync(DIR + '/calls.jsonl', JSON.stringify({ model, contents, system: config?.systemInstruction, temperature: config?.temperature, mime: config?.responseMimeType }) + '\n');
      let script = [];
      try { script = JSON.parse(fs.readFileSync(DIR + '/script.json', 'utf8')); } catch {}
      if (!script.length) throw new Error('STUB: script exhausted');
      const next = script.shift();
      fs.writeFileSync(DIR + '/script.json', JSON.stringify(script));
      if (next.error) { const e = new Error(next.error.message || 'stub error'); e.status = next.error.status; throw e; }
      return { text: typeof next.text === 'string' ? next.text : JSON.stringify(next.json) };
    },
  };
}
