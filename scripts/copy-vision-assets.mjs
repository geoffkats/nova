import { cp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const destination = join(root, 'public', 'mediapipe', 'wasm');

await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true, force: true });
