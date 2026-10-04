/** JSON export/import — TZ A-06, I-11 (no zip/docx endpoints) */

import { Decision } from '../types/decision';

export function exportDecisionJson(d: Decision): Blob {
  const payload = {
    schemaVersion: d.schemaVersion,
    exportedAt: new Date().toISOString(),
    decision: d,
  };
  return new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json',
  });
}

export function exportAllJson(decisions: Decision[]): Blob {
  return new Blob(
    [
      JSON.stringify(
        {
          schemaVersion: 8,
          exportedAt: new Date().toISOString(),
          decisions,
        },
        null,
        2
      ),
    ],
    { type: 'application/json' }
  );
}

export function downloadBlob(blob: Blob, filename: string) {
  const u = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = u;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(u);
}

export function parseImportedJson(text: string): Decision[] {
  const data = JSON.parse(text);
  if (Array.isArray(data.decisions)) return data.decisions;
  if (data.decision) return [data.decision];
  if (Array.isArray(data)) return data;
  throw new Error('Unknown import format');
}
