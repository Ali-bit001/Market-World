const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const settingsController = require('../controllers/settings.controller');

router.get('/', auth, settingsController.getSettings);
router.patch('/', auth, settingsController.updateSettings);
router.get('/exchange-rates', settingsController.getExchangeRates);

module.exports = router;
