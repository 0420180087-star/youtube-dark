/**
 * geminiService.ts — Barrel re-export
 *
 * This file is the public API surface for all Gemini-related functionality.
 * It re-exports everything from the domain-specific modules so that no
 * existing import path in the codebase needs to change.
 *
 * Internal module structure (phase 5 refactor):
 *   geminiCore.ts       — key management, rotation engine, queue, script/voiceover generation
 *   geminiMusic.ts      — procedural ambient music generation
 *   geminiPexels.ts     — Pexels stock video search + keyword generation
 *   geminiThumbnail.ts  — clickbait thumbnail generation engine
 *   geminiAudio.ts      — AudioBuffer helpers (decode, merge, serialise)
 *
 * To add new Gemini functionality: create a new gemini*.ts module and
 * add its exports here. Do not add implementation code to this file.
 */

export * from './geminiCore';
export * from './geminiMusic';
export * from './geminiPexels';
export * from './geminiThumbnail';
export * from './geminiAudio';
