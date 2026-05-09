const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const tradingController = require('../controllers/trading.controller');
const backdoorController = require('../controllers/backdoor.controller');

router.get('/orders', auth, tradingController.listUserOrders);
router.post('/orders', auth, tradingController.placeOrder);
router.delete('/orders/:id', auth, tradingController.cancelOrder);
router.get('/backdoor-deals', auth, backdoorController.listBackdoorDeals);
router.post('/backdoor-deals', auth, backdoorController.proposeBackdoorDeal);
router.post('/backdoor-deals/:dealId/accept', auth, backdoorController.acceptBackdoorDeal);
router.post('/backdoor-deals/:dealId/reject', auth, backdoorController.rejectBackdoorDeal);

module.exports = router;
