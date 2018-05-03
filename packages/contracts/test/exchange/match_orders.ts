import { LogWithDecodedArgs, ZeroEx } from '0x.js';
import { BlockchainLifecycle } from '@0xproject/dev-utils';
import { BigNumber } from '@0xproject/utils';
import * as chai from 'chai';
import ethUtil = require('ethereumjs-util');
import * as _ from 'lodash';

import { DummyERC20TokenContract } from '../../src/contract_wrappers/generated/dummy_e_r_c20_token';
import { DummyERC721TokenContract } from '../../src/contract_wrappers/generated/dummy_e_r_c721_token';
import { ERC20ProxyContract } from '../../src/contract_wrappers/generated/e_r_c20_proxy';
import { ERC721ProxyContract } from '../../src/contract_wrappers/generated/e_r_c721_proxy';
import {
    CancelContractEventArgs,
    ExchangeContract,
    ExchangeStatusContractEventArgs,
    FillContractEventArgs,
} from '../../src/contract_wrappers/generated/exchange';
import { assetProxyUtils } from '../../src/utils/asset_proxy_utils';
import { constants } from '../../src/utils/constants';
import { crypto } from '../../src/utils/crypto';
import { ERC20Wrapper } from '../../src/utils/erc20_wrapper';
import { ERC721Wrapper } from '../../src/utils/erc721_wrapper';
import { ExchangeWrapper } from '../../src/utils/exchange_wrapper';
import { OrderFactory } from '../../src/utils/order_factory';
import { orderUtils } from '../../src/utils/order_utils';
import { AssetProxyId, ContractName, ERC20BalancesByOwner, ExchangeStatus, SignedOrder } from '../../src/utils/types';
import { chaiSetup } from '../utils/chai_setup';
import { deployer } from '../utils/deployer';
import { provider, web3Wrapper } from '../utils/web3_wrapper';

import { MatchOrderTester } from '../utils/match_order_tester';

chaiSetup.configure();
const expect = chai.expect;
const blockchainLifecycle = new BlockchainLifecycle(web3Wrapper);

describe.only('MatchOrders', () => {
    let makerAddressLeft: string;
    let makerAddressRight: string;
    let owner: string;
    let takerAddress: string;
    let feeRecipientAddressLeft: string;
    let feeRecipientAddressRight: string;

    let erc20TokenA: DummyERC20TokenContract;
    let erc20TokenB: DummyERC20TokenContract;
    let zrxToken: DummyERC20TokenContract;
    let erc721Token: DummyERC721TokenContract;
    let exchange: ExchangeContract;
    let erc20Proxy: ERC20ProxyContract;
    let erc721Proxy: ERC721ProxyContract;

    let signedOrder: SignedOrder;
    let erc20Balances: ERC20BalancesByOwner;
    let exchangeWrapper: ExchangeWrapper;
    let erc20Wrapper: ERC20Wrapper;
    let erc721Wrapper: ERC721Wrapper;
    let orderFactoryLeft: OrderFactory;
    let orderFactoryRight: OrderFactory;

    let erc721MakerAssetIds: BigNumber[];
    let erc721TakerAssetIds: BigNumber[];

    let defaultMakerAssetAddress: string;
    let defaultTakerAssetAddress: string;

    let matchOrderTester: MatchOrderTester;

    let zeroEx: ZeroEx;

    before(async () => {
        const accounts = await web3Wrapper.getAvailableAddressesAsync();
        const usedAddresses = ([
            owner,
            makerAddressLeft,
            makerAddressRight,
            takerAddress,
            feeRecipientAddressLeft,
            feeRecipientAddressRight,
        ] = accounts);

        erc20Wrapper = new ERC20Wrapper(deployer, provider, usedAddresses, owner);
        erc721Wrapper = new ERC721Wrapper(deployer, provider, usedAddresses, owner);

        [erc20TokenA, erc20TokenB, zrxToken] = await erc20Wrapper.deployDummyTokensAsync();
        erc20Proxy = await erc20Wrapper.deployProxyAsync();
        await erc20Wrapper.setBalancesAndAllowancesAsync();

        [erc721Token] = await erc721Wrapper.deployDummyTokensAsync();
        erc721Proxy = await erc721Wrapper.deployProxyAsync();
        await erc721Wrapper.setBalancesAndAllowancesAsync();
        const erc721Balances = await erc721Wrapper.getBalancesAsync();
        erc721MakerAssetIds = erc721Balances[makerAddressLeft][erc721Token.address];
        erc721MakerAssetIds = erc721Balances[makerAddressRight][erc721Token.address];
        erc721TakerAssetIds = erc721Balances[takerAddress][erc721Token.address];

        const exchangeInstance = await deployer.deployAsync(ContractName.Exchange, [
            assetProxyUtils.encodeERC20ProxyData(zrxToken.address),
        ]);
        exchange = new ExchangeContract(exchangeInstance.abi, exchangeInstance.address, provider);
        zeroEx = new ZeroEx(provider, {
            exchangeContractAddress: exchange.address,
            networkId: constants.TESTRPC_NETWORK_ID,
        });
        exchangeWrapper = new ExchangeWrapper(exchange, zeroEx);
        await exchangeWrapper.registerAssetProxyAsync(AssetProxyId.ERC20, erc20Proxy.address, owner);
        await exchangeWrapper.registerAssetProxyAsync(AssetProxyId.ERC721, erc721Proxy.address, owner);

        await erc20Proxy.addAuthorizedAddress.sendTransactionAsync(exchange.address, {
            from: owner,
        });
        await erc721Proxy.addAuthorizedAddress.sendTransactionAsync(exchange.address, {
            from: owner,
        });

        defaultMakerAssetAddress = erc20TokenA.address;
        defaultTakerAssetAddress = erc20TokenB.address;

        const defaultOrderParams = {
            ...constants.STATIC_ORDER_PARAMS,
            exchangeAddress: exchange.address,
            makerAssetData: assetProxyUtils.encodeERC20ProxyData(defaultMakerAssetAddress),
            takerAssetData: assetProxyUtils.encodeERC20ProxyData(defaultTakerAssetAddress),
        };
        const privateKeyLeft = constants.TESTRPC_PRIVATE_KEYS[accounts.indexOf(makerAddressLeft)];
        orderFactoryLeft = new OrderFactory(privateKeyLeft, defaultOrderParams);

        const privateKeyRight = constants.TESTRPC_PRIVATE_KEYS[accounts.indexOf(makerAddressRight)];
        orderFactoryRight = new OrderFactory(privateKeyRight, defaultOrderParams);

        matchOrderTester = new MatchOrderTester(exchangeWrapper, erc20Wrapper);
    });
    beforeEach(async () => {
        await blockchainLifecycle.startAsync();
    });
    afterEach(async () => {
        await blockchainLifecycle.revertAsync();
    });

    describe('matchOrders', () => {
        beforeEach(async () => {
            erc20Balances = await erc20Wrapper.getBalancesAsync();
        });

        it('should transfer the correct amounts when orders completely fill each other', async () => {
            const signedOrderLeft = orderFactoryLeft.newSignedOrder({
                makerAddress: makerAddressLeft,
                makerAssetData: assetProxyUtils.encodeERC20ProxyData(defaultMakerAssetAddress),
                takerAssetData: assetProxyUtils.encodeERC20ProxyData(defaultTakerAssetAddress),
                makerAssetAmount: new BigNumber(5),
                takerAssetAmount: new BigNumber(10),
                feeRecipientAddress: feeRecipientAddressLeft,
            });

            const signedOrderRight = orderFactoryRight.newSignedOrder({
                makerAddress: makerAddressRight,
                makerAssetData: assetProxyUtils.encodeERC20ProxyData(defaultTakerAssetAddress),
                takerAssetData: assetProxyUtils.encodeERC20ProxyData(defaultMakerAssetAddress),
                makerAssetAmount: new BigNumber(10),
                takerAssetAmount: new BigNumber(2),
                feeRecipientAddress: feeRecipientAddressRight,
            });

            await matchOrderTester.matchOrders(
                signedOrderLeft,
                signedOrderRight,
                defaultMakerAssetAddress,
                defaultTakerAssetAddress,
                zrxToken.address,
                takerAddress,
                erc20Balances,
            );
        });

        it('should transfer the correct amounts when left order is completely filled and right order is partially filled', async () => {
            const signedOrderLeft = orderFactoryLeft.newSignedOrder({
                makerAddress: makerAddressLeft,
                makerAssetData: assetProxyUtils.encodeERC20ProxyData(defaultMakerAssetAddress),
                takerAssetData: assetProxyUtils.encodeERC20ProxyData(defaultTakerAssetAddress),
                makerAssetAmount: new BigNumber(5),
                takerAssetAmount: new BigNumber(10),
                feeRecipientAddress: feeRecipientAddressLeft,
            });

            const signedOrderRight = orderFactoryRight.newSignedOrder({
                makerAddress: makerAddressRight,
                makerAssetData: assetProxyUtils.encodeERC20ProxyData(defaultTakerAssetAddress),
                takerAssetData: assetProxyUtils.encodeERC20ProxyData(defaultMakerAssetAddress),
                makerAssetAmount: new BigNumber(20),
                takerAssetAmount: new BigNumber(4),
                feeRecipientAddress: feeRecipientAddressRight,
            });

            await matchOrderTester.matchOrders(
                signedOrderLeft,
                signedOrderRight,
                defaultMakerAssetAddress,
                defaultTakerAssetAddress,
                zrxToken.address,
                takerAddress,
                erc20Balances,
            );
        });

        it('should transfer the correct amounts when right order is completely filled and left order is partially filled', async () => {
            const signedOrderLeft = orderFactoryLeft.newSignedOrder({
                makerAddress: makerAddressLeft,
                makerAssetData: assetProxyUtils.encodeERC20ProxyData(defaultMakerAssetAddress),
                takerAssetData: assetProxyUtils.encodeERC20ProxyData(defaultTakerAssetAddress),
                makerAssetAmount: new BigNumber(50),
                takerAssetAmount: new BigNumber(100),
                feeRecipientAddress: feeRecipientAddressLeft,
            });

            const signedOrderRight = orderFactoryRight.newSignedOrder({
                makerAddress: makerAddressRight,
                makerAssetData: assetProxyUtils.encodeERC20ProxyData(defaultTakerAssetAddress),
                takerAssetData: assetProxyUtils.encodeERC20ProxyData(defaultMakerAssetAddress),
                makerAssetAmount: new BigNumber(10),
                takerAssetAmount: new BigNumber(2),
                feeRecipientAddress: feeRecipientAddressRight,
            });

            await matchOrderTester.matchOrders(
                signedOrderLeft,
                signedOrderRight,
                defaultMakerAssetAddress,
                defaultTakerAssetAddress,
                zrxToken.address,
                takerAddress,
                erc20Balances,
            );
        });

        it('should transfer the correct amounts when consecutive calls are used to completely fill the left order', async () => {
            const signedOrderLeft = orderFactoryLeft.newSignedOrder({
                makerAddress: makerAddressLeft,
                makerAssetData: assetProxyUtils.encodeERC20ProxyData(defaultMakerAssetAddress),
                takerAssetData: assetProxyUtils.encodeERC20ProxyData(defaultTakerAssetAddress),
                makerAssetAmount: new BigNumber(50),
                takerAssetAmount: new BigNumber(100),
                feeRecipientAddress: feeRecipientAddressLeft,
            });

            const signedOrderRight = orderFactoryRight.newSignedOrder({
                makerAddress: makerAddressRight,
                makerAssetData: assetProxyUtils.encodeERC20ProxyData(defaultTakerAssetAddress),
                takerAssetData: assetProxyUtils.encodeERC20ProxyData(defaultMakerAssetAddress),
                makerAssetAmount: new BigNumber(10),
                takerAssetAmount: new BigNumber(2),
                feeRecipientAddress: feeRecipientAddressRight,
            });

            const newERC20BalancesByOwner = await matchOrderTester.matchOrders(
                signedOrderLeft,
                signedOrderRight,
                defaultMakerAssetAddress,
                defaultTakerAssetAddress,
                zrxToken.address,
                takerAddress,
                erc20Balances,
            );

            const signedOrderRight2 = orderFactoryRight.newSignedOrder({
                makerAddress: makerAddressRight,
                makerAssetData: assetProxyUtils.encodeERC20ProxyData(defaultTakerAssetAddress),
                takerAssetData: assetProxyUtils.encodeERC20ProxyData(defaultMakerAssetAddress),
                makerAssetAmount: new BigNumber(90),
                takerAssetAmount: new BigNumber(6),
                feeRecipientAddress: feeRecipientAddressRight,
            });

            const leftTakerAssetFilledAmount = signedOrderRight.makerAssetAmount;
            const rightTakerAssetFilledAmount = new BigNumber(0);
            await matchOrderTester.matchOrders(
                signedOrderLeft,
                signedOrderRight2,
                defaultMakerAssetAddress,
                defaultTakerAssetAddress,
                zrxToken.address,
                takerAddress,
                newERC20BalancesByOwner,
                leftTakerAssetFilledAmount,
                rightTakerAssetFilledAmount,
            );
        });

        it('should transfer the correct amounts when consecutive calls are used to completely fill the right order', async () => {
            const signedOrderLeft = orderFactoryLeft.newSignedOrder({
                makerAddress: makerAddressLeft,
                makerAssetData: assetProxyUtils.encodeERC20ProxyData(defaultMakerAssetAddress),
                takerAssetData: assetProxyUtils.encodeERC20ProxyData(defaultTakerAssetAddress),
                makerAssetAmount: new BigNumber(10),
                takerAssetAmount: new BigNumber(2),
                feeRecipientAddress: feeRecipientAddressLeft,
            });

            const signedOrderRight = orderFactoryRight.newSignedOrder({
                makerAddress: makerAddressRight,
                makerAssetData: assetProxyUtils.encodeERC20ProxyData(defaultTakerAssetAddress),
                takerAssetData: assetProxyUtils.encodeERC20ProxyData(defaultMakerAssetAddress),
                makerAssetAmount: new BigNumber(50),
                takerAssetAmount: new BigNumber(100),
                feeRecipientAddress: feeRecipientAddressRight,
            });

            const newERC20BalancesByOwner = await matchOrderTester.matchOrders(
                signedOrderLeft,
                signedOrderRight,
                defaultMakerAssetAddress,
                defaultTakerAssetAddress,
                zrxToken.address,
                takerAddress,
                erc20Balances,
            );

            const signedOrderLeft2 = orderFactoryLeft.newSignedOrder({
                makerAddress: makerAddressLeft,
                makerAssetData: assetProxyUtils.encodeERC20ProxyData(defaultMakerAssetAddress),
                takerAssetData: assetProxyUtils.encodeERC20ProxyData(defaultTakerAssetAddress),
                makerAssetAmount: new BigNumber(90),
                takerAssetAmount: new BigNumber(6),
                feeRecipientAddress: feeRecipientAddressLeft,
            });

            const leftTakerAssetFilledAmount = new BigNumber(0);
            const takerAmountReceived = newERC20BalancesByOwner[takerAddress][defaultMakerAssetAddress].minus(
                erc20Balances[takerAddress][defaultMakerAssetAddress],
            );
            const rightTakerAssetFilledAmount = signedOrderLeft.makerAssetAmount.minus(takerAmountReceived);
            await matchOrderTester.matchOrders(
                signedOrderLeft2,
                signedOrderRight,
                defaultMakerAssetAddress,
                defaultTakerAssetAddress,
                zrxToken.address,
                takerAddress,
                newERC20BalancesByOwner,
                leftTakerAssetFilledAmount,
                rightTakerAssetFilledAmount,
            );
        });

        it('should transfer the correct amounts if fee recipient is the same across both matched orders', async () => {
            const feeRecipientAddress = feeRecipientAddressLeft;
            const signedOrderLeft = orderFactoryLeft.newSignedOrder({
                makerAddress: makerAddressLeft,
                makerAssetData: assetProxyUtils.encodeERC20ProxyData(defaultMakerAssetAddress),
                takerAssetData: assetProxyUtils.encodeERC20ProxyData(defaultTakerAssetAddress),
                makerAssetAmount: new BigNumber(5),
                takerAssetAmount: new BigNumber(10),
                feeRecipientAddress,
            });

            const signedOrderRight = orderFactoryRight.newSignedOrder({
                makerAddress: makerAddressRight,
                makerAssetData: assetProxyUtils.encodeERC20ProxyData(defaultTakerAssetAddress),
                takerAssetData: assetProxyUtils.encodeERC20ProxyData(defaultMakerAssetAddress),
                makerAssetAmount: new BigNumber(10),
                takerAssetAmount: new BigNumber(2),
                feeRecipientAddress,
            });

            await matchOrderTester.matchOrders(
                signedOrderLeft,
                signedOrderRight,
                defaultMakerAssetAddress,
                defaultTakerAssetAddress,
                zrxToken.address,
                takerAddress,
                erc20Balances,
            );
        });
        /*
        it.only('should transfer the correct amounts if taker is also the left order maker', async () => {
            const signedOrderLeft = orderFactoryLeft.newSignedOrder({
                makerAddress: makerAddressLeft,
                makerAssetData: assetProxyUtils.encodeERC20ProxyData(defaultMakerAssetAddress),
                takerAssetData: assetProxyUtils.encodeERC20ProxyData(defaultTakerAssetAddress),
                makerAssetAmount: new BigNumber(5),
                takerAssetAmount: new BigNumber(10),
                feeRecipientAddress: feeRecipientAddressLeft,
            });

            const signedOrderRight = orderFactoryRight.newSignedOrder({
                makerAddress: makerAddressRight,
                makerAssetData: assetProxyUtils.encodeERC20ProxyData(defaultTakerAssetAddress),
                takerAssetData: assetProxyUtils.encodeERC20ProxyData(defaultMakerAssetAddress),
                makerAssetAmount: new BigNumber(10),
                takerAssetAmount: new BigNumber(2),
                feeRecipientAddress: feeRecipientAddressRight,
            });

            takerAddress = signedOrderLeft.makerAddress;
            await matchOrderTester.matchOrders(
                signedOrderLeft,
                signedOrderRight,
                defaultMakerAssetAddress,
                defaultTakerAssetAddress,
                zrxToken.address,
                takerAddress,
                erc20Balances,
            );
        }); */

        /*
        it.only('', async () => {

        it.only('should transfer the correct amounts if taker is also the right order maker', async () => {

        it.only('should transfer the correct amounts if taker is also the fee recipient', async () => {

        it.only('should transfer the correct amounts if left maker is also the fee recipient', async () => {

        it.only('should transfer the correct amounts if right maker is also the fee recipient', async () => {

*/

        it('should throw if there is not a positive spread', async () => {
            const signedOrderLeft = orderFactoryLeft.newSignedOrder({
                makerAddress: makerAddressLeft,
                makerAssetData: assetProxyUtils.encodeERC20ProxyData(defaultMakerAssetAddress),
                takerAssetData: assetProxyUtils.encodeERC20ProxyData(defaultTakerAssetAddress),
                makerAssetAmount: new BigNumber(5),
                takerAssetAmount: new BigNumber(100),
                feeRecipientAddress: feeRecipientAddressLeft,
            });

            const signedOrderRight = orderFactoryRight.newSignedOrder({
                makerAddress: makerAddressRight,
                makerAssetData: assetProxyUtils.encodeERC20ProxyData(defaultTakerAssetAddress),
                takerAssetData: assetProxyUtils.encodeERC20ProxyData(defaultMakerAssetAddress),
                makerAssetAmount: new BigNumber(1),
                takerAssetAmount: new BigNumber(200),
                feeRecipientAddress: feeRecipientAddressRight,
            });

            return expect(
                matchOrderTester.matchOrders(
                    signedOrderLeft,
                    signedOrderRight,
                    defaultMakerAssetAddress,
                    defaultTakerAssetAddress,
                    zrxToken.address,
                    takerAddress,
                    erc20Balances,
                ),
            ).to.be.rejectedWith(constants.REVERT);
        });

        /*
            Should throw if left order is cancelled
            Should throw if right order is cancelled

            Should throw if left order maker token is not the same as right maker token.

        */
    });
}); // tslint:disable-line:max-file-line-count
