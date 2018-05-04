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

import "../LibOrder.sol";

contract MExchangeCore is LibOrder {

    struct FillResults {
        uint256 makerAssetFilledAmount;
        uint256 takerAssetFilledAmount;
        uint256 makerFeePaid;
        uint256 takerFeePaid;
    }

    function fillOrder(
        Order memory order,
        uint256 takerAssetFillAmount,
        bytes memory signature)
        public
        returns (FillResults memory fillResults);

    function cancelOrder(Order memory order)
        public
        returns (bool);

    function cancelOrdersUpTo(uint256 salt)
        external;

    function getOrderStatus(Order memory order)
        public
        view
        returns (
            uint8 status,
            bytes32 orderHash,
            uint256 filledAmount);


    function getFillAmounts(
        Order memory order,
        uint8 orderStatus,
        uint256 filledAmount,
        uint256 takerAssetFillAmount,
        address takerAddress)
        public
        pure
        returns (
            uint8 status,
            FillResults memory fillResults);

    function updateFilledState(
        Order memory order,
        address takerAddress,
        bytes32 orderHash,
        FillResults memory fillResults)
        internal;


        function isRoundingError(uint256 numerator, uint256 denominator, uint256 target)
            public pure
            returns (bool isError);
}
