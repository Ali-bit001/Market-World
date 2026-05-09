const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const marketController = require('../controllers/market.controller');

router.get('/snapshot', auth, marketController.getWorldSnapshot);
router.get('/history', auth, marketController.getAssetHistory);
router.get('/assets', auth, marketController.getMarketAssets);
router.get('/orderbook', auth, marketController.getOrderBookAggregated);

module.exports = router;
