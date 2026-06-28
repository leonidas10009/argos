import { describe, it, expect } from 'vitest';
import { StreamNormalizer } from '../src/analysis/StreamNormalizer';

describe('StreamNormalizer', () => {
  const normalizer = new StreamNormalizer(true);

  describe('quality detection', () => {
    it('detects 4K', () => {
      const info = normalizer.normalize('https://host.com/video.mp4', ['4K', '2160p']);
      expect(info.quality).toBe('4K');
    });

    it('detects 1080p', () => {
      const info = normalizer.normalize('https://host.com/video.mp4', ['1080p', 'FHD']);
      expect(info.quality).toBe('1080p');
    });

    it('detects 720p', () => {
      const info = normalizer.normalize('https://host.com/video.mp4', ['720p']);
      expect(info.quality).toBe('720p');
    });

    it('detects HD', () => {
      const info = normalizer.normalize('https://host.com/video.mp4', ['HD']);
      expect(info.quality).toBe('HD');
    });

    it('detects CAM', () => {
      const info = normalizer.normalize('https://host.com/video.mp4', ['CAMRip', 'telesync']);
      expect(info.quality).toBe('CAM');
    });

    it('returns unknown for no match', () => {
      const info = normalizer.normalize('https://host.com/video.mp4', []);
      expect(info.quality).toBe('unknown');
    });
  });

  describe('language detection', () => {
    it('detects spanish (ES)', () => {
      const info = normalizer.normalize('https://host.com/video.mp4', ['Latino', 'audio latino']);
      expect(info.language).toBe('ES');
    });

    it('detects english (EN)', () => {
      const info = normalizer.normalize('https://host.com/video.mp4', ['English', 'sub']);
      expect(info.language).toBe('EN');
    });

    it('detects japanese (JA)', () => {
      const info = normalizer.normalize('https://host.com/video.mp4', ['Japones', 'sub']);
      expect(info.language).toBe('JA');
    });

    it('defaults to ES with spanishBias=true when no language detected', () => {
      const info = normalizer.normalize('https://host.com/video.mp4', ['server 1']);
      expect(info.language).toBe('ES');
    });
  });

  describe('stream type detection', () => {
    it('detects m3u8', () => {
      const info = normalizer.normalize('https://host.com/video.m3u8', []);
      expect(info.type).toBe('m3u8');
    });

    it('detects mp4', () => {
      const info = normalizer.normalize('https://host.com/video.mp4', []);
      expect(info.type).toBe('mp4');
    });

    it('detects embed', () => {
      const info = normalizer.normalize('https://host.com/embed/abc', []);
      expect(info.type).toBe('embed');
    });

    it('detects torrent', () => {
      const info = normalizer.normalize('magnet:?xt=urn:btih:abc123', []);
      expect(info.type).toBe('torrent');
    });
  });

  describe('priority scoring', () => {
    it('ranks 4K ES mp4 highest', () => {
      const info = normalizer.normalize('https://host.com/video.mp4', ['4K', 'Latino']);
      expect(info.priority).toBeGreaterThanOrEqual(90);
    });

    it('ranks CAM lower than HD with same language', () => {
      const cam = normalizer.normalize('https://host.com/cam.mp4', ['CAM']);
      const hd = normalizer.normalize('https://host.com/hd.mp4', ['HD']);
      expect(cam.priority).toBeLessThan(hd.priority);
    });

    it('penalizes ad-labeled streams', () => {
      const ad = normalizer.normalize('https://host.com/video.mp4', ['ad', 'publicidad']);
      const clean = normalizer.normalize('https://host.com/video.mp4', ['server 1']);
      expect(ad.priority).toBeLessThan(clean.priority);
    });
  });

  describe('sortByPriority', () => {
    it('sorts streams by priority descending', () => {
      const s1 = normalizer.normalize('https://a.com/video.mp4', ['4K', 'Latino']);
      const s2 = normalizer.normalize('https://b.com/video.mp4', ['720p']);
      const s3 = normalizer.normalize('https://c.com/video.mp4', ['CAM']);

      const sorted = normalizer.sortByPriority([s3, s1, s2]);
      expect(sorted[0].url).toBe('https://a.com/video.mp4');
      expect(sorted[2].url).toBe('https://c.com/video.mp4');
    });
  });

  describe('deduplicate', () => {
    it('removes duplicate URLs with same serverName and quality', () => {
      const s1 = normalizer.normalize('https://streamtape.com/e/abc', ['1080p']);
      const s2 = normalizer.normalize('https://streamtape.com/e/abc', ['1080p']); // dup
      const s3 = normalizer.normalize('https://streamtape.com/e/xyz', ['1080p']); // different

      const deduped = normalizer.deduplicate([s1, s2, s3]);
      expect(deduped.length).toBe(2);
    });
  });

  describe('batch normalization', () => {
    it('normalizes multiple URLs with common labels', () => {
      const results = normalizer.normalizeBatch(
        ['https://a.com/v.mp4', 'https://b.com/v.m3u8'],
        ['1080p', 'Latino']
      );
      expect(results.length).toBe(2);
      expect(results[0].quality).toBe('1080p');
      expect(results[0].language).toBe('ES');
    });
  });

  describe('enrichWithEmbed', () => {
    it('updates directUrl and type when resolved', () => {
      const info = normalizer.enrichWithEmbed(
        'https://streamwish.to/e/abc',
        'https://cdn.com/video.mp4',
        ['server 1']
      );
      expect(info.directUrl).toBe('https://cdn.com/video.mp4');
      expect(info.type).toBe('mp4');
    });
  });
});
