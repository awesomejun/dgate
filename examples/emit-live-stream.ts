#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const samplePath = path.join(__dirname, 'sample-session.jsonl');
const lines = fs
  .readFileSync(samplePath, 'utf8')
  .split(/\r?\n/)
  .filter((l) => l.trim().length > 0);

let idx = 0;

function emitNext(): void {
  const line = lines[idx % lines.length]!;
  process.stdout.write(line + '\n');
  idx++;
  setTimeout(emitNext, 900);
}

process.stdout.on('error', () => process.exit(0));
emitNext();
