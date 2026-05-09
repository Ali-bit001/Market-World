const express = require('express');
const router = express.Router();
const worldController = require('../controllers/world.controller');
const auth = require('../middleware/auth');

router.get('/', worldController.listWorlds);
router.post('/:id/join', auth, worldController.joinWorld);
router.post('/leave', auth, worldController.leaveWorld);
router.get('/:id/stock-markets', auth, worldController.getWorldStockMarkets);
router.get('/:id/stock-markets/:marketId/listings', auth, worldController.getStockMarketListings);
router.get('/:id/country-indicators', auth, worldController.getCountryMacroIndicators);
router.get('/:id/leaderboard', auth, worldController.getLeaderboard);
router.get('/:id/events', auth, worldController.getWorldEvents);

module.exports = router;
