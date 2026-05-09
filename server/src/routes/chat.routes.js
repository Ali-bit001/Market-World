const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const chatController = require('../controllers/chat.controller');

router.use(auth);

router.get('/users', chatController.listWorldUsers);
router.get('/world', chatController.getWorldMessages);
router.post('/world', chatController.postWorldMessage);
router.get('/direct', chatController.getDirectMessages);
router.post('/direct', chatController.postDirectMessage);

module.exports = router;
