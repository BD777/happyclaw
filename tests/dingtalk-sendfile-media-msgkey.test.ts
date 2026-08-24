import { describe, expect, test } from 'vitest';

import { buildDingTalkFileSendPayload } from '../src/dingtalk.js';

describe('DingTalk sendFile uses media-native robot msgKeys', () => {
  test('mp4 uses sampleVideo with videoMediaId, not sampleFile', () => {
    const payload = buildDingTalkFileSendPayload(
      'video',
      'media-video-1',
      'clip.mp4',
      'mp4',
    );
    expect(payload.msgKey).toBe('sampleVideo');
    expect(payload.msgParam).toEqual({
      duration: '1',
      videoMediaId: 'media-video-1',
      videoType: 'mp4',
      picMediaId: 'media-video-1',
    });
  });

  test('amr/mp3/wav use sampleAudio with mediaId + duration', () => {
    for (const ext of ['amr', 'mp3', 'wav']) {
      const payload = buildDingTalkFileSendPayload(
        'voice',
        'media-voice-1',
        `voice.${ext}`,
        ext,
      );
      expect(payload.msgKey).toBe('sampleAudio');
      expect(payload.msgParam).toEqual({
        mediaId: 'media-voice-1',
        duration: '1',
      });
    }
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
});
