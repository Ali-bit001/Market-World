const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const portfolioController = require('../controllers/portfolio.controller');

router.get('/', auth, portfolioController.getPortfolio);

module.exports = router;
