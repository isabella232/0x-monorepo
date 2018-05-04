/*
  Copyright 2018 ZeroEx Intl.
  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at
    http://www.apache.org/licenses/LICENSE-2.0
  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
*/

pragma solidity ^0.4.21;
pragma experimental ABIEncoderV2;

import "./mixins/MExchangeCore.sol";
import "./mixins/MMatchOrders.sol";
import "./mixins/MSettlement.sol";
import "./mixins/MTransactions.sol";
import "../../utils/SafeMath/SafeMath.sol";
import "./LibOrder.sol";
import "./LibStatus.sol";
import "./LibPartialAmount.sol";
import "../../utils/LibBytes/LibBytes.sol";

contract MixinMatchOrders is
    SafeMath,
    LibBytes,
    LibStatus,
    LibOrder,
    LibPartialAmount,
    MExchangeCore,
    MMatchOrders,
    MSettlement,
    MTransactions
    {

    function validateMatchOrdersContextOrRevert(Order memory left, Order memory right)
        private
    {
        // The Left Order's maker asset must be the same as the Right Order's taker asset.
        require(areBytesEqual(left.makerAssetData, right.takerAssetData));

        // The Left Order's taker asset must be the same as the Right Order's maker asset.
        require(areBytesEqual(left.takerAssetData, right.makerAssetData));

        // Make sure there is a positive spread.
        // There is a positive spread iff the cost per unit bought (MakerAmount/TakerAmount) for each order is greater
        // than the profit per unit sold of the matched order (TakerAmount/MakerAmount).
        // This is satisfied by the equations below:
        // <left.makerAssetAmount> / <left.takerAssetAmount> >= <right.takerAssetAmount> / <right.makerAssetAmount>
        // AND
        // <right.makerAssetAmount> / <right.takerAssetAmount> >= <left.takerAssetAmount> / <left.makerAssetAmount>
        // These equations can be combined to get the following:
        require(safeMul(left.makerAssetAmount, right.makerAssetAmount) >= safeMul(left.takerAssetAmount, right.takerAssetAmount));
    }

    function getMatchedFillAmounts(Order memory left, Order memory right, uint8 leftStatus, uint8 rightStatus, uint256 leftFilledAmount, uint256 rightFilledAmount)
        private
        returns (uint8 status, MatchedOrderFillAmounts memory matchedFillOrderAmounts)
    {
        // The goal is for taker to obtain the maximum number of left maker asset.
        // We settle orders at the price point defined by the right order (profit goes to the order taker)
        // The constraint can be either on the left or on the right.
        // The constraint is on the left iff the amount required to fill the left order
        // is less than or equal to the amount we can spend from the right order:
        //    <leftTakerAssetAmountRemaining> <= <rightTakerAssetAmountRemaining> * <rightMakerToTakerRatio>
        //    <leftTakerAssetAmountRemaining> <= <rightTakerAssetAmountRemaining> * <right.makerAssetAmount> / <right.takerAssetAmount>
        //    <leftTakerAssetAmountRemaining> * <right.takerAssetAmount> <= <rightTakerAssetAmountRemaining> * <right.makerAssetAmount>
        uint256 rightTakerAssetAmountRemaining = safeSub(right.takerAssetAmount, rightFilledAmount);
        uint256 leftTakerAssetAmountRemaining = safeSub(left.takerAssetAmount, leftFilledAmount);
        if(safeMul(leftTakerAssetAmountRemaining, right.takerAssetAmount) <= safeMul(rightTakerAssetAmountRemaining, right.makerAssetAmount))
        {
            // Left order is the constraint: maximally fill left
            (   status,
                matchedFillOrderAmounts.left
            ) = getFillAmounts(
                left,
                leftStatus,
                leftFilledAmount,
                leftTakerAssetAmountRemaining,
                msg.sender);
            if(status != uint8(Status.SUCCESS)) {
                return;
            }

            // The right order just spent <leftTakerAssetAmountRemaining> of their maker asset to fill the left order.
            // The amount right gets in return is:
            //    <leftOrderAmountBought> * <rightProfitPerUnitSold>
            // =  <matchedFillOrderAmounts.left.takerAssetFilledAmount> * <right.takerAssetAmount> / <right.makerAssetAmount>
            if(isRoundingError(right.takerAssetAmount, right.makerAssetAmount, matchedFillOrderAmounts.left.takerAssetFilledAmount)) {
                status = uint8(Status.ROUNDING_ERROR_TOO_LARGE);
                return;
            }
            uint256 rightFill = getPartialAmount(
                right.takerAssetAmount,
                right.makerAssetAmount,
                matchedFillOrderAmounts.left.takerAssetFilledAmount);

            // Compute fill amounts
            (   status,
                matchedFillOrderAmounts.right
            ) = getFillAmounts(
                right,
                rightStatus,
                rightFilledAmount,
                rightFill,
                msg.sender);
            if(status != uint8(Status.SUCCESS)) {
                return;
            }

            // The right order must spend at least as much as we're transferring to the left order's maker.
            // If the amount transferred from the right order is greater than what is transferred, it is a rounding error amount.
            // Ensure this difference is negligible by dividing the values with each other. The result should equal to ~1.
            assert(matchedFillOrderAmounts.right.makerAssetFilledAmount >= matchedFillOrderAmounts.left.takerAssetFilledAmount);
            if(isRoundingError(matchedFillOrderAmounts.right.makerAssetFilledAmount, matchedFillOrderAmounts.left.takerAssetFilledAmount, 1)) {
                status = uint8(Status.ROUNDING_ERROR_TOO_LARGE);
                return;
            }
        } else {
            // Right order is the constraint: maximally fill right
            (   status,
                matchedFillOrderAmounts.right
            ) = getFillAmounts(
                right,
                rightStatus,
                rightFilledAmount,
                rightTakerAssetAmountRemaining,
                msg.sender);
            if(status != uint8(Status.SUCCESS)) {
                return;
            }

            // The left order just spent <rightTakerAssetAmountRemaining> of their maker asset to fill the right order.
            // The amount left gets in return is:
            //    <rightOrderAmountBought> * <rightCostPerUnitSold>
            //   (let Y = <matchedFillOrderAmounts.right.takerAssetFilledAmount>; let X = matchedFillOrderAmounts.right.makerAssetFilledAmount)
            // = Y * X / Y
            // = X = <matchedFillOrderAmounts.right.makerAssetFilledAmount>
            // * We assert that amount transferred by the right order must not exceed the amount required to fill the left order.
            assert(matchedFillOrderAmounts.right.makerAssetFilledAmount <= leftTakerAssetAmountRemaining);
            (   status,
                matchedFillOrderAmounts.left
            ) = getFillAmounts(
                left,
                leftStatus,
                leftFilledAmount,
                matchedFillOrderAmounts.right.makerAssetFilledAmount,
                msg.sender);
            if(status != uint8(Status.SUCCESS)) {
                return;
            }

            // The amount sent from the right order must equal the amount received by the left order.
            assert(matchedFillOrderAmounts.right.makerAssetFilledAmount == matchedFillOrderAmounts.left.takerAssetFilledAmount);
        }
    }

    // Match two complementary orders that overlap.
    // The taker will end up with the maximum amount of left.makerAsset
    // Any right.makerAsset that taker would gain because of rounding are
    // transfered to right.
    function matchOrders(
        Order memory left,
        Order memory right,
        bytes leftSignature,
        bytes rightSignature)
        public
        returns (
            uint256 leftFilledAmount,
            uint256 rightFilledAmount)
    {
        // Get left status
        uint8 leftStatus;
        bytes32 leftOrderHash;
        (   leftStatus,
            leftOrderHash,
            leftFilledAmount
        ) = getOrderStatus(left);
        if(leftStatus != uint8(Status.ORDER_FILLABLE)) {
            emit ExchangeStatus(uint8(leftStatus), leftOrderHash);
            return;
        }

        // Get right status
        uint8 rightStatus;
        bytes32 rightOrderHash;
        (   rightStatus,
            rightOrderHash,
            rightFilledAmount
        ) = getOrderStatus(right);
        if(rightStatus != uint8(Status.ORDER_FILLABLE)) {
            emit ExchangeStatus(uint8(rightStatus), leftOrderHash);
            return;
        }

        // Fetch taker address
        address takerAddress = getCurrentContextAddress();

        // Either our context is valid or we revert
        validateMatchOrdersContextOrRevert(left, right);

        // Compute proportional fill amounts
        MatchedOrderFillAmounts memory matchedFillOrderAmounts;
        uint8 matchedFillAmountsStatus;
        (   matchedFillAmountsStatus,
            matchedFillOrderAmounts
        ) = getMatchedFillAmounts(
            left,
            right,
            leftStatus,
            rightStatus,
            leftFilledAmount,
            rightFilledAmount);
        if(matchedFillAmountsStatus != uint8(Status.SUCCESS)) {
            return;
        }

        // Settle matched orders. Succeeds or throws.
        settleMatchedOrders(left, right, matchedFillOrderAmounts, takerAddress);

        // Update exchange state
        updateFilledState(
            left,
            right.makerAddress,
            leftOrderHash,
            matchedFillOrderAmounts.left
        );
        updateFilledState(
            right,
            left.makerAddress,
            rightOrderHash,
            matchedFillOrderAmounts.right
        );
    }
}
