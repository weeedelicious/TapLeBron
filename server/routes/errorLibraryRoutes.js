const express = require('express');
const { listNodeGenerationErrors } = require('../services/ErrorService');

const errorLibraryRouter = express.Router();
const ERROR_LIBRARY_OWNER = '吴逸翔';

function requireErrorLibraryOwner(req, res, next) {
  if (String(req.user?.username || '').trim() !== ERROR_LIBRARY_OWNER) {
    res.status(403).json({ error: '只有吴逸翔可以查看报错库' });
    return;
  }
  next();
}

errorLibraryRouter.use(requireErrorLibraryOwner);

errorLibraryRouter.get('/', async (req, res, next) => {
  try {
    const result = await listNodeGenerationErrors({
      date: req.query.date,
      period: req.query.period,
      username: req.query.username,
      operationType: req.query.operationType,
      model: req.query.model,
      keyword: req.query.keyword,
      sortOrder: req.query.sortOrder,
      page: req.query.page,
      pageSize: req.query.pageSize,
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

module.exports = {
  ERROR_LIBRARY_OWNER,
  errorLibraryRouter,
  requireErrorLibraryOwner,
};
