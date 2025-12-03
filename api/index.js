const ytdl = require('ytdl-core');const fetch = require('node-fetch');const cheerio = require('cheerio');const rateLimit = require('express-rate-limit');const cors = require('cors');// Minimal express-like wrapper for Vercel serverless functions:module.exports = async (req, res) => {
  // CORS (allow all origins for demo — tighten in production)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // Simple API key check
  const API_KEY = process.env.API_KEY || 'testkey';
  const provided = req.headers['x-api-key'] || req.query.api_key;
  if (!provided || provided !== API_KEY) {
    res.statusCode = 401;
    res.json({ error: 'missing/invalid api key. set header x-api-key.' });
    return;
  }

  // Basic rate limiting (in-memory, safe for serverless cold starts but not ideal for scale)
  // We implement a trivial per-key ratelimit using a global object. For production use Redis.
  if (!global._ratelimit) global._ratelimit = {};
  const key = provided;
  const limit = 200; // requests per hour default (change as needed)
  const windowMs = 60 * 60 * 1000;
  const now = Date.now();
  if (!global._ratelimit[key]) global._ratelimit[key] = { start: now, count: 0 };
  const bucket = global._ratelimit[key];
  if (now - bucket.start > windowMs) {
    bucket.start = now; bucket.count = 0;
  }
  bucket.count++;
  if (bucket.count > limit) {
    res.statusCode = 429;
    res.json({ error: 'rate limit exceeded' });
    return;
  }

  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    // ROUTE: /api/youtube?url=<youtube_url>
    if (pathname === '/api/youtube') {
      const videoUrl = url.searchParams.get('url') || (req.method === 'POST' ? req.body && req.body.url : undefined);
      if (!videoUrl || !ytdl.validateURL(videoUrl)) {
        res.statusCode = 400;
        res.json({ error: 'missing or invalid "url" param (YouTube URL expected)' });
        return;
      }

      const info = await ytdl.getInfo(videoUrl);
      const formats = info.formats
        .filter(f => f.contentLength || f.audioBitrate || f.bitrate) // filter useless ones
        .map(f => ({
          itag: f.itag,
          mimeType: f.mimeType,
          qualityLabel: f.qualityLabel || null,
          audioBitrate: f.audioBitrate || null,
          approximateSize: f.contentLength ? Number(f.contentLength) : null,
          url: f.url // direct signed URL returned by ytdl-core
        }));

      return res.json({
        id: info.videoDetails.videoId,
        title: info.videoDetails.title,
        author: info.videoDetails.author && info.videoDetails.author.name,
        lengthSeconds: info.videoDetails.lengthSeconds,
        formats
      });
    }

    // ROUTE: /api/instagram?username=<username>
    if (pathname === '/api/instagram') {
      const username = url.searchParams.get('username');
      if (!username) {
        res.statusCode = 400;
        res.json({ error: 'missing "username" param' });
        return;
      }

      // fetch instagram page HTML and parse og:image
      const target = `https://www.instagram.com/${encodeURIComponent(username)}/`;
      const r = await fetch(target, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) {
        res.statusCode = 404;
        res.json({ error: 'instagram user not found or blocked' });
        return;
      }
      const html = await r.text();

      // Try to parse JSON LD or meta property og:image
      const $ = cheerio.load(html);
      let dp = $('meta[property="og:image"]').attr('content') || $('meta[name="og:image"]').attr('content');

      // Fallback: try regex for window._sharedData (older pages) — not guaranteed
      if (!dp) {
        const m = html.match(/"profile_pic_url_hd":"([^"]+)"/);
        if (m) dp = m[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/');
      }

      if (!dp) {
        res.statusCode = 500;
        res.json({ error: 'could not extract profile image (instagram may have blocked scraping)' });
        return;
      }

      return res.json({ username, dp });
    }

    // default: health check
    if (pathname === '/' || pathname === '/api') {
      res.json({ ok: true, endpoints: ['/api/youtube?url=', '/api/instagram?username='] });
      return;
    }

    res.statusCode = 404;
    res.json({ error: 'not found' });
  } catch (err) {
    console.error(err);
    res.statusCode = 500;
    res.json({ error: 'internal error', details: err.message });
  }
};
