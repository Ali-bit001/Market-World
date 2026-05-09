const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const companyController = require('../controllers/company.controller');

router.get('/sectors', auth, companyController.listSectors);
router.get('/', auth, companyController.listMyCompanies);
router.get('/private-deals', auth, companyController.listPrivateDeals);
router.post('/private-deals/:dealId/accept', auth, companyController.acceptPrivateDeal);
router.post('/private-deals/:dealId/reject', auth, companyController.rejectPrivateDeal);
router.post('/', auth, companyController.createCompany);
router.patch('/:id/settings', auth, companyController.updateCompanySettings);
router.post('/:id/list-shares', auth, companyController.listCompanyShares);
router.post('/:id/list-on-market', auth, companyController.listCompanyOnMarket);
router.post('/:id/private-deal', auth, companyController.executePrivateDeal);
router.post('/:id/liquidate', auth, companyController.liquidateCompany);

module.exports = router;
