import { describe, it, expect } from 'vitest';
import { EmbedResolver } from '../src/analysis/EmbedResolver';

describe('EmbedResolver', () => {
  const resolver = new EmbedResolver();

  describe('isDirectVideoUrl', () => {
    it('detects m3u8', () => {
      expect(resolver.isDirectVideoUrl('https://cdn.com/video.m3u8')).toBe(true);
    });
    it('detects mp4', () => {
      expect(resolver.isDirectVideoUrl('https://cdn.com/video.mp4')).toBe(true);
    });
    it('detects mp4upload', () => {
      expect(resolver.isDirectVideoUrl('https://a123.mp4upload.com:8080/d/abc/video.mp4')).toBe(true);
    });
    it('rejects embed URLs', () => {
      expect(resolver.isDirectVideoUrl('https://streamwish.to/e/abc')).toBe(false);
    });
    it('rejects empty', () => {
      expect(resolver.isDirectVideoUrl('')).toBe(false);
    });
  });

  describe('clearCache', () => {
    it('clears without error', () => {
      expect(() => resolver.clearCache()).not.toThrow();
    });
  });
});
