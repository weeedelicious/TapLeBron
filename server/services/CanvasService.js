const db = require('../db');

module.exports = {
  hydrateCanvasRow: db.hydrateCanvasRow,
  hydrateCanvasRows: db.hydrateCanvasRows,
  isSeparateContentDatabase: db.isSeparateContentDatabase,
  maybeCreateCanvasRevision: db.maybeCreateCanvasRevision,
  parseJsonDocument: db.parseJsonDocument,
  saveCanvasData: db.saveCanvasData,
  starterCanvas: db.starterCanvas,
};
