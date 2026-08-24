import { describe, expect, test } from 'vitest';

import {
  buildDingTalkFileSendPayload,
  getDingTalkMediaDurationSeconds,
} from '../src/dingtalk.js';

describe('DingTalk sendFile uses media-native robot msgKeys', () => {
  test('mp4 uses parsed seconds and a distinct uploaded cover', () => {
    const payload = buildDingTalkFileSendPayload(
      'video',
      'media-video-1',
      'clip.mp4',
      'mp4',
      { durationSeconds: 1.25, picMediaId: 'media-cover-1' },
    );
    expect(payload.msgKey).toBe('sampleVideo');
    expect(payload.msgParam).toEqual({
      duration: '2',
      videoMediaId: 'media-video-1',
      videoType: 'mp4',
      picMediaId: 'media-cover-1',
    });
  });

  test('video without valid metadata and a distinct cover degrades to a file', () => {
    for (const metadata of [
      {},
      { durationSeconds: 0, picMediaId: 'media-cover-1' },
      { durationSeconds: 2, picMediaId: 'media-video-1' },
    ]) {
      expect(
        buildDingTalkFileSendPayload(
          'video',
          'media-video-1',
          'clip.mp4',
          'mp4',
          metadata,
        ).msgKey,
      ).toBe('sampleFile');
    }
  });

  test('amr/mp3/wav use sampleAudio with duration converted to milliseconds', () => {
    for (const ext of ['amr', 'mp3', 'wav']) {
      const payload = buildDingTalkFileSendPayload(
        'voice',
        'media-voice-1',
        `voice.${ext}`,
        ext,
        { durationSeconds: 1.234 },
      );
      expect(payload.msgKey).toBe('sampleAudio');
      expect(payload.msgParam).toEqual({
        mediaId: 'media-voice-1',
        duration: '1234',
      });
    }
  });

  test('unsupported native formats and missing duration degrade to sampleFile', () => {
    expect(
      buildDingTalkFileSendPayload(
        'voice',
        'media-voice-1',
        'voice.ogg',
        'ogg',
        { durationSeconds: 3 },
      ).msgKey,
    ).toBe('sampleFile');
    expect(
      buildDingTalkFileSendPayload('voice', 'media-voice-1', 'voice.mp3', 'mp3')
        .msgKey,
    ).toBe('sampleFile');
    expect(
      buildDingTalkFileSendPayload(
        'image',
        'media-image-1',
        'image.webp',
        'webp',
      ).msgKey,
    ).toBe('sampleFile');
  });

  test('documents still use sampleFile', () => {
    const payload = buildDingTalkFileSendPayload(
      'file',
      'media-doc-1',
      'notes.pdf',
      'pdf',
    );
    expect(payload.msgKey).toBe('sampleFile');
    expect(payload.msgParam).toEqual({
      mediaId: 'media-doc-1',
      fileName: 'notes.pdf',
      fileType: 'pdf',
    });
  });

  test('parses real AMR frame duration', async () => {
    const header = Buffer.from('#!AMR\n');
    // FT=0 narrow-band frames are 13 octets and represent 20ms each.
    const frame = Buffer.alloc(13);
    const buffer = Buffer.concat([header, frame, frame, frame]);

    await expect(getDingTalkMediaDurationSeconds(buffer, 'amr')).resolves.toBe(
      0.06,
    );
  });

  test('parses real WAV duration from its media header', async () => {
    const sampleRate = 8_000;
    const samples = sampleRate;
    const buffer = Buffer.alloc(44 + samples * 2);
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(buffer.length - 8, 4);
    buffer.write('WAVEfmt ', 8);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(1, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * 2, 28);
    buffer.writeUInt16LE(2, 32);
    buffer.writeUInt16LE(16, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(samples * 2, 40);

    await expect(getDingTalkMediaDurationSeconds(buffer, 'wav')).resolves.toBe(
      1,
    );
  });
});
