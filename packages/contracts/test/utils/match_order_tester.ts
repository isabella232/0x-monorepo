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

chaiSetup.configure();
const expect = chai.expect;
const blockchainLifecycle = new BlockchainLifecycle(web3Wrapper);

export class MatchOrderTester {
    private _exchangeWrapper: ExchangeWrapper;
    private _erc20Wrapper: ERC20Wrapper;

    constructor(exchangeWrapper: ExchangeWrapper, erc20Wrapper: ERC20Wrapper) {
        this._exchangeWrapper = exchangeWrapper;
        this._erc20Wrapper = erc20Wrapper;
    }

    public async matchOrdersAndVerifyBalancesAsync(
        signedOrderLeft: SignedOrder,
        signedOrderRight: SignedOrder,
        makerAssetAddressLeft: string,
        takerAssetAddressLeft: string,
        feeTokenAddress: string,
        takerAddress: string,
        erc20BalancesByOwner: ERC20BalancesByOwner,
        initialTakerAssetFilledAmountLeft?: BigNumber,
        initialTakerAssetFilledAmountRight?: BigNumber,
    ): Promise<ERC20BalancesByOwner> {
        /////////// Test setup & verifying preconditions ///////////
        const makerAddressLeft = signedOrderLeft.makerAddress;
        const makerAddressRight = signedOrderRight.makerAddress;
        const makerAssetAddressRight = takerAssetAddressLeft;
        const takerAssetAddressRight = makerAssetAddressLeft;
        const feeRecipientAddressLeft = signedOrderLeft.feeRecipientAddress;
        const feeRecipientAddressRight = signedOrderRight.feeRecipientAddress;
        // Verify Left order preconditions
        const takerAssetFilledAmountBeforeLeft = await this._exchangeWrapper.getTakerAssetFilledAmountAsync(
            orderUtils.getOrderHashHex(signedOrderLeft),
        );
        const expectedTakerAssetFilledAmountBeforeLeft = initialTakerAssetFilledAmountLeft
            ? initialTakerAssetFilledAmountLeft
            : 0;
        expect(takerAssetFilledAmountBeforeLeft).to.be.bignumber.equal(expectedTakerAssetFilledAmountBeforeLeft);
        // Verify Right order preconditions
        const takerAssetFilledAmountBeforeRight = await this._exchangeWrapper.getTakerAssetFilledAmountAsync(
            orderUtils.getOrderHashHex(signedOrderRight),
        );
        const expectedTakerAssetFilledAmountBeforeRight = initialTakerAssetFilledAmountRight
            ? initialTakerAssetFilledAmountRight
            : 0;
        expect(takerAssetFilledAmountBeforeRight).to.be.bignumber.equal(expectedTakerAssetFilledAmountBeforeRight);

        /////////// Match Left & Right orders ///////////
        await this._exchangeWrapper.matchOrdersAsync(signedOrderLeft, signedOrderRight, takerAddress);
        const newBalances = await this._erc20Wrapper.getBalancesAsync();

        /////////// Construct expected new balances ///////////
        const expectedNewBalances = _.cloneDeep(erc20BalancesByOwner);
        // Left Maker makerAsset
        let amountBoughtByLeftMaker = await this._exchangeWrapper.getTakerAssetFilledAmountAsync(
            orderUtils.getOrderHashHex(signedOrderLeft),
        );
        amountBoughtByLeftMaker = amountBoughtByLeftMaker.minus(expectedTakerAssetFilledAmountBeforeLeft);
        const amountSoldByLeftMaker = amountBoughtByLeftMaker
            .times(signedOrderLeft.makerAssetAmount)
            .dividedToIntegerBy(signedOrderLeft.takerAssetAmount);
        expectedNewBalances[makerAddressLeft][makerAssetAddressLeft] = expectedNewBalances[makerAddressLeft][
            makerAssetAddressLeft
        ].minus(amountSoldByLeftMaker);
        // Right Maker makerAsset
        let amountBoughtByRightMaker = await this._exchangeWrapper.getTakerAssetFilledAmountAsync(
            orderUtils.getOrderHashHex(signedOrderRight),
        );
        amountBoughtByRightMaker = amountBoughtByRightMaker.minus(expectedTakerAssetFilledAmountBeforeRight);
        const amountSoldByRightMaker = amountBoughtByRightMaker
            .times(signedOrderRight.makerAssetAmount)
            .dividedToIntegerBy(signedOrderRight.takerAssetAmount);
        expectedNewBalances[makerAddressRight][makerAssetAddressRight] = expectedNewBalances[makerAddressRight][
            makerAssetAddressRight
        ].minus(amountSoldByRightMaker);
        // Left Maker takerAssetAddressLeft
        const amountReceivedByLeftMaker = amountSoldByRightMaker;
        expectedNewBalances[makerAddressLeft][takerAssetAddressLeft] = expectedNewBalances[makerAddressLeft][
            takerAssetAddressLeft
        ].add(amountReceivedByLeftMaker);
        // Right Maker takerAssetAddressRight
        const amountReceivedByRightMaker = amountBoughtByLeftMaker
            .times(signedOrderRight.takerAssetAmount)
            .dividedToIntegerBy(signedOrderRight.makerAssetAmount);
        expectedNewBalances[makerAddressRight][takerAssetAddressRight] = expectedNewBalances[makerAddressRight][
            takerAssetAddressRight
        ].add(amountReceivedByRightMaker);
        // Taker's asset
        const amountReceivedByTaker = amountSoldByLeftMaker.minus(amountReceivedByRightMaker);
        expectedNewBalances[takerAddress][makerAssetAddressLeft] = expectedNewBalances[takerAddress][
            makerAssetAddressLeft
        ].add(amountReceivedByTaker);
        // Left Maker Fees
        const leftMakerFeePaid = signedOrderLeft.makerFee
            .times(amountSoldByLeftMaker)
            .dividedToIntegerBy(signedOrderLeft.makerAssetAmount);
        expectedNewBalances[makerAddressLeft][feeTokenAddress] = expectedNewBalances[makerAddressLeft][
            feeTokenAddress
        ].minus(leftMakerFeePaid);
        // Right Maker Fees
        const rightMakerFeePaid = signedOrderRight.makerFee
            .times(amountSoldByRightMaker)
            .dividedToIntegerBy(signedOrderRight.makerAssetAmount);
        expectedNewBalances[makerAddressRight][feeTokenAddress] = expectedNewBalances[makerAddressRight][
            feeTokenAddress
        ].minus(rightMakerFeePaid);
        // Taker Fees
        const takerFeePaidLeft = signedOrderLeft.takerFee
            .times(amountSoldByLeftMaker)
            .dividedToIntegerBy(signedOrderLeft.makerAssetAmount);
        const takerFeePaidRight = signedOrderRight.takerFee
            .times(amountSoldByRightMaker)
            .dividedToIntegerBy(signedOrderRight.makerAssetAmount);
        const takerFeePaid = takerFeePaidLeft.add(takerFeePaidRight);
        expectedNewBalances[takerAddress][feeTokenAddress] = expectedNewBalances[takerAddress][feeTokenAddress].minus(
            takerFeePaid,
        );
        // Left Fee Recipient Fees
        const feesReceivedLeft = leftMakerFeePaid.add(takerFeePaidLeft);
        expectedNewBalances[feeRecipientAddressLeft][feeTokenAddress] = expectedNewBalances[feeRecipientAddressLeft][
            feeTokenAddress
        ].add(feesReceivedLeft);
        // Right Fee Recipient Fees
        const feesReceivedRight = rightMakerFeePaid.add(takerFeePaidRight);
        expectedNewBalances[feeRecipientAddressRight][feeTokenAddress] = expectedNewBalances[feeRecipientAddressRight][
            feeTokenAddress
        ].add(feesReceivedRight);

        /////////// Assert our expected new balances are equal to the actual balances ///////////
        expect(expectedNewBalances).to.be.deep.equal(newBalances);
        return newBalances;
    }
}
