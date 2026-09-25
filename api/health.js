'use strict';

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(200).json({
    status:      'ok',
    apiKey:      process.env.OPENROUTER_API_KEY ? 'configured' : 'missing',
    sheetId:     process.env.GDRIVE_SHEET_ID    ? 'configured' : 'missing',
    imagesId:    process.env.GDRIVE_IMAGES_ID   ? 'configured' : 'missing',
    googleCreds: process.env.GOOGLE_CREDENTIALS ? 'configured' : 'missing',
    adminSecret: process.env.ADMIN_SECRET        ? 'configured' : 'using-default',
    provider:    'OpenRouter',
    ts:          new Date().toISOString(),
  });
};
