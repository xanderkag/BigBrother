import { ACCEPTED_AUDIO_MIMES } from '../../storage/files.js';

/**
 * True when the (magic-bytes-detected) MIME type is an audio format that
 * routes to the ASR transcribe path instead of the OCR engine chain.
 * Single source of truth — used by the upload route (gating) and the
 * orchestrator (routing).
 */
export function isAudioMime(mimeType: string): boolean {
  return ACCEPTED_AUDIO_MIMES.has(mimeType) || mimeType.startsWith('audio/');
}
