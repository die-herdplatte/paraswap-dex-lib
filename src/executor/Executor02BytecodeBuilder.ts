import { ethers } from 'ethers';
import {
  Address,
  OptimalRate,
  OptimalRoute,
  OptimalSwap,
  OptimalSwapExchange,
} from '@paraswap/core';
import { DexExchangeParam } from '../types';
import { Executors, Flag, SpecialDex } from './types';
import { isETHAddress } from '../utils';
import { DepositWithdrawReturn } from '../dex/weth/types';
import { ExecutorBytecodeBuilder } from './ExecutorBytecodeBuilder';
import {
  BYTES_28_LENGTH,
  BYTES_64_LENGTH,
  DEFAULT_RETURN_AMOUNT_POS,
  EXECUTORS_FUNCTION_CALL_DATA_TYPES,
  SWAP_EXCHANGE_100_PERCENTAGE,
  ZEROS_20_BYTES,
  ZEROS_28_BYTES,
  ZEROS_4_BYTES,
} from './constants';

const {
  utils: { hexlify, hexDataLength, hexConcat, hexZeroPad, solidityPack },
} = ethers;

/**
 * Class to build bytecode for Executor02 - simpleSwap with N DEXs (VERTICAL_BRANCH), multiSwaps (VERTICAL_BRANCH_HORIZONTAL_SEQUENCE) and megaswaps (NESTED_VERTICAL_BRANCH_HORIZONTAL_SEQUENCE)
 */
export class Executor02BytecodeBuilder extends ExecutorBytecodeBuilder {
  /**
   * Executor02 Flags:
   * switch (flag % 4):
   * case 0: don't instert fromAmount
   * case 1: sendEth equal to fromAmount
   * case 2: sendEth equal to fromAmount + insert fromAmount
   * case 3: insert fromAmount

   * switch (flag % 3):
   * case 0: don't check balance after swap
   * case 1: check eth balance after swap
   * case 2: check destToken balance after swap
   */
  protected buildSimpleSwapFlags(
    priceRoute: OptimalRate,
    exchangeParam: DexExchangeParam,
    routeIndex: number,
    swapIndex: number,
    swapExchangeIndex: number,
    exchangeParamIndex: number,
    maybeWethCallData?: DepositWithdrawReturn,
  ): { dexFlag: Flag; approveFlag: Flag } {
    const { srcToken, destToken } =
      priceRoute.bestRoute[routeIndex].swaps[swapIndex];
    const isEthSrc = isETHAddress(srcToken);
    const isEthDest = isETHAddress(destToken);

    const { dexFuncHasRecipient, needWrapNative } = exchangeParam;

    const needWrap = needWrapNative && isEthSrc && maybeWethCallData?.deposit;
    const needUnwrap =
      needWrapNative && isEthDest && maybeWethCallData?.withdraw;

    let dexFlag = Flag.DONT_INSERT_FROM_AMOUNT_DONT_CHECK_BALANCE_AFTER_SWAP; // 0
    let approveFlag =
      Flag.DONT_INSERT_FROM_AMOUNT_DONT_CHECK_BALANCE_AFTER_SWAP; // 0

    if (isEthSrc && !needWrap) {
      dexFlag =
        Flag.SEND_ETH_EQUAL_TO_FROM_AMOUNT_CHECK_SRC_TOKEN_BALANCE_AFTER_SWAP; // 5
    } else if (isEthDest && !needUnwrap) {
      dexFlag = Flag.DONT_INSERT_FROM_AMOUNT_CHECK_ETH_BALANCE_AFTER_SWAP; // 4
    } else if (!dexFuncHasRecipient || (isEthDest && needUnwrap)) {
      dexFlag = Flag.DONT_INSERT_FROM_AMOUNT_CHECK_SRC_TOKEN_BALANCE_AFTER_SWAP; // 8
    }

    return {
      dexFlag,
      approveFlag,
    };
  }

  /**
   * Executor02 Flags:
   * switch (flag % 4):
   * case 0: don't instert fromAmount
   * case 1: sendEth equal to fromAmount
   * case 2: sendEth equal to fromAmount + insert fromAmount
   * case 3: insert fromAmount

   * switch (flag % 3):
   * case 0: don't check balance after swap
   * case 1: check eth balance after swap
   * case 2: check destToken balance after swap
   */
  protected buildMultiMegaSwapFlags(
    priceRoute: OptimalRate,
    exchangeParam: DexExchangeParam,
    routeIndex: number,
    swapIndex: number,
    swapExchangeIndex: number,
    exchangeParamIndex: number,
    maybeWethCallData?: DepositWithdrawReturn,
  ): { dexFlag: Flag; approveFlag: Flag } {
    const route = priceRoute.bestRoute[routeIndex];
    const swap = route.swaps[swapIndex];

    const { srcToken, destToken } = swap;
    const isEthSrc = isETHAddress(srcToken);
    const isEthDest = isETHAddress(destToken);

    const applyVerticalBranching = this.doesSwapNeedToApplyVerticalBranching(
      priceRoute,
      routeIndex,
      swap,
    );

    // const isVerticalSequence = swap.swapExchanges.length > 1; // check if there is a vertical split (percentages)
    const isHorizontalSequence = route.swaps.length > 1; // check if route is a multi-swap (horizontal sequence)

    const isFirstSwap = swapIndex === 0;
    // const isNotFirstSwap = swapIndex !== 0;
    const isLastSwap = !isFirstSwap && swapIndex === route.swaps.length - 1;

    const { dexFuncHasRecipient, needWrapNative, specialDexFlag } =
      exchangeParam;

    const isSpecialDex =
      specialDexFlag !== undefined && specialDexFlag !== SpecialDex.DEFAULT;

    const needWrap = needWrapNative && isEthSrc && maybeWethCallData?.deposit;
    const needUnwrap =
      needWrapNative && isEthDest && maybeWethCallData?.withdraw;

    let dexFlag = Flag.DONT_INSERT_FROM_AMOUNT_DONT_CHECK_BALANCE_AFTER_SWAP; // 0
    let approveFlag =
      Flag.DONT_INSERT_FROM_AMOUNT_DONT_CHECK_BALANCE_AFTER_SWAP; // 0

    if (isFirstSwap) {
      if (applyVerticalBranching || isSpecialDex) {
        // keep default flags
      } else if (isEthSrc && !needWrap) {
        dexFlag = isHorizontalSequence
          ? Flag.SEND_ETH_EQUAL_TO_FROM_AMOUNT_CHECK_SRC_TOKEN_BALANCE_AFTER_SWAP // 5
          : Flag.SEND_ETH_EQUAL_TO_FROM_AMOUNT_DONT_CHECK_BALANCE_AFTER_SWAP; // 9
      } else if (
        (isEthSrc && needWrap) ||
        (!isEthSrc && !isEthDest) ||
        (isEthDest && needUnwrap)
      ) {
        dexFlag = isHorizontalSequence
          ? Flag.DONT_INSERT_FROM_AMOUNT_CHECK_SRC_TOKEN_BALANCE_AFTER_SWAP // 8
          : Flag.DONT_INSERT_FROM_AMOUNT_DONT_CHECK_BALANCE_AFTER_SWAP; // 0
      } else if (isEthDest && !needUnwrap) {
        dexFlag = isHorizontalSequence
          ? Flag.DONT_INSERT_FROM_AMOUNT_CHECK_ETH_BALANCE_AFTER_SWAP // 4
          : Flag.DONT_INSERT_FROM_AMOUNT_DONT_CHECK_BALANCE_AFTER_SWAP; // 0
      } else if (!dexFuncHasRecipient) {
        dexFlag =
          Flag.DONT_INSERT_FROM_AMOUNT_CHECK_SRC_TOKEN_BALANCE_AFTER_SWAP; // 8
      }
    } else {
      if (isSpecialDex && !isLastSwap) {
        // keep default flags
      } else if (isEthSrc && !needWrap && !isSpecialDex) {
        dexFlag =
          isHorizontalSequence && !isLastSwap
            ? Flag.SEND_ETH_EQUAL_TO_FROM_AMOUNT_CHECK_SRC_TOKEN_BALANCE_AFTER_SWAP // 5
            : Flag.SEND_ETH_EQUAL_TO_FROM_AMOUNT_DONT_CHECK_BALANCE_AFTER_SWAP; // 9
      } else if (isEthSrc && needWrap && !isSpecialDex) {
        dexFlag = Flag.INSERT_FROM_AMOUNT_DONT_CHECK_BALANCE_AFTER_SWAP; // 3
        approveFlag = Flag.INSERT_FROM_AMOUNT_DONT_CHECK_BALANCE_AFTER_SWAP; // 3
      } else if (needUnwrap && !isSpecialDex) {
        dexFlag =
          isHorizontalSequence && !isLastSwap
            ? Flag.INSERT_FROM_AMOUNT_CHECK_SRC_TOKEN_BALANCE_AFTER_SWAP // 11
            : Flag.INSERT_FROM_AMOUNT_DONT_CHECK_BALANCE_AFTER_SWAP; // 3
        approveFlag = Flag.INSERT_FROM_AMOUNT_DONT_CHECK_BALANCE_AFTER_SWAP; // 3
      } else if (isSpecialDex) {
        if (isEthDest && !needUnwrap) {
          dexFlag =
            isHorizontalSequence || isLastSwap
              ? Flag.DONT_INSERT_FROM_AMOUNT_DONT_CHECK_BALANCE_AFTER_SWAP // 0
              : Flag.DONT_INSERT_FROM_AMOUNT_CHECK_ETH_BALANCE_AFTER_SWAP; // 4
        } else if (isEthSrc && !needWrap) {
          dexFlag =
            Flag.SEND_ETH_EQUAL_TO_FROM_AMOUNT_CHECK_SRC_TOKEN_BALANCE_AFTER_SWAP; // 5
        } else {
          dexFlag =
            isHorizontalSequence || isLastSwap
              ? Flag.DONT_INSERT_FROM_AMOUNT_CHECK_SRC_TOKEN_BALANCE_AFTER_SWAP // 8
              : Flag.DONT_INSERT_FROM_AMOUNT_CHECK_SRC_TOKEN_BALANCE_AFTER_SWAP; // 0
        }
        approveFlag = Flag.INSERT_FROM_AMOUNT_DONT_CHECK_BALANCE_AFTER_SWAP; // 3
      } else {
        dexFlag = Flag.INSERT_FROM_AMOUNT_DONT_CHECK_BALANCE_AFTER_SWAP; // 3
        approveFlag = Flag.INSERT_FROM_AMOUNT_DONT_CHECK_BALANCE_AFTER_SWAP; // 3
      }
    }

    return {
      dexFlag,
      approveFlag,
    };
  }

  protected buildDexCallData(
    swap: OptimalSwap,
    exchangeParam: DexExchangeParam,
    index: number,
    flag: Flag,
    swapExchange: OptimalSwapExchange<any>,
  ): string {
    const dontCheckBalanceAfterSwap = flag % 3 === 0;
    const checkDestTokenBalanceAfterSwap = flag % 3 === 2;
    const insertFromAmount = flag % 4 === 3;
    let { exchangeData } = exchangeParam;

    let destTokenPos = 0;
    if (checkDestTokenBalanceAfterSwap && !dontCheckBalanceAfterSwap) {
      const destTokenAddr = isETHAddress(swap.destToken)
        ? this.dexHelper.config.data.wrappedNativeTokenAddress.toLowerCase()
        : swap.destToken.toLowerCase();

      if (!exchangeParam.dexFuncHasDestToken) {
        exchangeData = hexConcat([exchangeData, ZEROS_28_BYTES, destTokenAddr]);
      }

      const destTokenAddrIndex = exchangeData
        .replace('0x', '')
        .indexOf(destTokenAddr.replace('0x', ''));
      destTokenPos = (destTokenAddrIndex - 24) / 2;
    }

    let fromAmountPos = 0;
    if (insertFromAmount) {
      const fromAmount = ethers.utils.defaultAbiCoder.encode(
        ['uint256'],
        [swapExchange!.srcAmount],
      );
      const fromAmountIndex = exchangeData
        .replace('0x', '')
        .indexOf(fromAmount.replace('0x', ''));
      fromAmountPos = fromAmountIndex / 2;
    }

    const { specialDexFlag } = exchangeParam;

    return solidityPack(EXECUTORS_FUNCTION_CALL_DATA_TYPES, [
      exchangeParam.targetExchange, // target exchange
      hexZeroPad(hexlify(hexDataLength(exchangeData) + BYTES_28_LENGTH), 4), // dex calldata length + bytes28(0)
      hexZeroPad(hexlify(fromAmountPos), 2), // fromAmountPos
      hexZeroPad(hexlify(destTokenPos), 2), // destTokenPos
      DEFAULT_RETURN_AMOUNT_POS, // return amount position
      hexZeroPad(hexlify(specialDexFlag || SpecialDex.DEFAULT), 1), // special
      hexZeroPad(hexlify(flag), 2), // flag
      ZEROS_28_BYTES, // bytes28(0)
      exchangeData, // dex calldata
    ]);
  }

  private addMultiSwapMetadata(
    callData: string,
    percentage: number,
    srcTokenAddress: Address,
  ) {
    const srcTokenAddressLowered = srcTokenAddress.toLowerCase();
    let srcTokenPos: string;

    if (percentage === SWAP_EXCHANGE_100_PERCENTAGE) {
      srcTokenPos = hexZeroPad(hexlify(0), 8);
    } else if (isETHAddress(srcTokenAddressLowered)) {
      srcTokenPos = '0xEEEEEEEEEEEEEEEE';
    } else {
      const srcTokenAddrIndex = callData
        .replace('0x', '')
        .indexOf(srcTokenAddressLowered.replace('0x', ''));

      srcTokenPos = hexZeroPad(hexlify(srcTokenAddrIndex / 2), 8);
    }

    return solidityPack(
      ['bytes16', 'bytes8', 'bytes8', 'bytes'],
      [
        hexZeroPad(hexlify(hexDataLength(callData)), 16), // calldata size
        srcTokenPos, // srcTokenPos
        hexZeroPad(hexlify(Math.ceil(percentage * 100)), 8), // percentage
        callData, // swap calldata
      ],
    );
  }

  private packVerticalBranchingData(swapCallData: string): string {
    return solidityPack(
      ['bytes28', 'bytes4', 'bytes32', 'bytes32', 'bytes'],
      [
        ZEROS_28_BYTES, // empty bytes28
        ZEROS_4_BYTES, // fallback selector
        hexZeroPad(hexlify(32), 32), // calldata offset
        hexZeroPad(hexlify(hexDataLength(swapCallData)), 32), // calldata length
        swapCallData, // calldata
      ],
    );
  }

  private packVerticalBranchingCallData(
    verticalBranchingData: string,
    fromAmountPos: number,
    destTokenPos: number,
    flag: Flag,
  ): string {
    return solidityPack(
      [
        'bytes20',
        'bytes4',
        'bytes2',
        'bytes2',
        'bytes1',
        'bytes1',
        'bytes2',
        'bytes',
      ],
      [
        ZEROS_20_BYTES, // bytes20(0)
        hexZeroPad(hexlify(hexDataLength(verticalBranchingData)), 4), // dex calldata length
        hexZeroPad(hexlify(fromAmountPos), 2), // fromAmountPos
        hexZeroPad(hexlify(destTokenPos), 2), // destTokenPos
        hexZeroPad(hexlify(0), 1), // returnAmountPos
        hexZeroPad(hexlify(SpecialDex.EXECUTE_VERTICAL_BRANCHING), 1), // special
        hexZeroPad(hexlify(flag), 2), // flag
        verticalBranchingData, // dexes calldata
      ],
    );
  }

  private buildVerticalBranchingCallData(
    priceRoute: OptimalRate,
    routeIndex: number,
    exchangeParams: DexExchangeParam[],
    swap: OptimalSwap,
    swapCallData: string,
    flag: Flag,
  ) {
    const data = this.packVerticalBranchingData(swapCallData);

    const destTokenAddrLowered = swap.destToken.toLowerCase();
    const isEthDest = isETHAddress(destTokenAddrLowered);
    let anyDexNoNeedWrapNative: boolean = false;

    let destTokenPos: number;
    if (isEthDest) {
      anyDexNoNeedWrapNative = swap.swapExchanges
        .map(curSe => {
          let index = 0;
          let swapExchangeIndex = 0;
          priceRoute.bestRoute[routeIndex].swaps.map(curSwap =>
            curSwap.swapExchanges.map(async se => {
              if (Object.is(se, curSe)) {
                index = swapExchangeIndex;
              }
              swapExchangeIndex++;
            }),
          );

          const curExchangeParam = exchangeParams[index];

          return !curExchangeParam.needWrapNative;
        })
        .includes(true);
    }

    if (isEthDest && anyDexNoNeedWrapNative) {
      destTokenPos = 0;
    } else {
      const destTokenAddrIndex = data
        .replace('0x', '')
        .indexOf(
          (isEthDest
            ? this.dexHelper.config.data.wrappedNativeTokenAddress
            : destTokenAddrLowered
          ).replace('0x', ''),
        );

      destTokenPos = destTokenAddrIndex / 2 - 40;
    }

    const fromAmountPos = hexDataLength(data) - 64 - 28; // 64 (position), 28 (selector padding);

    return this.packVerticalBranchingCallData(
      data,
      fromAmountPos,
      destTokenPos,
      flag,
    );
  }

  private buildSingleSwapExchangeCallData(
    priceRoute: OptimalRate,
    routeIndex: number,
    swap: OptimalSwap,
    swapExchange: OptimalSwapExchange<any>,
    exchangeParams: DexExchangeParam[],
    flags: { approves: Flag[]; dexes: Flag[]; wrap: Flag },
    maybeWethCallData?: DepositWithdrawReturn,
    addMultiSwapMetadata?: boolean,
    applyVerticalBranching?: boolean,
  ): string {
    let swapExchangeCallData = '';
    const srcAmount = swapExchange.srcAmount;

    let swapIndex = 0;
    let swapIndexTemp = 0;
    let swapExchangeIndex = 0;
    let swapExchangeIndexTemp = 0;

    priceRoute.bestRoute.map(route =>
      route.swaps.map(curSwap => {
        if (Object.is(curSwap, swap)) {
          swapIndex = swapIndexTemp;
        }
        swapIndexTemp++;

        curSwap.swapExchanges.map(async se => {
          if (Object.is(se, swapExchange)) {
            swapExchangeIndex = swapExchangeIndexTemp;
          }
          swapExchangeIndexTemp++;
        });
      }),
    );

    const curExchangeParam = exchangeParams[swapExchangeIndex];

    const dexCallData = this.buildDexCallData(
      swap,
      curExchangeParam,
      swapExchangeIndex,
      flags.dexes[swapExchangeIndex],
      swapExchange,
    );

    swapExchangeCallData = hexConcat([dexCallData]);

    const isLastSwap =
      swapIndex === priceRoute.bestRoute[routeIndex].swaps.length - 1;
    const isLast = swapExchangeIndex === exchangeParams.length - 1;

    if (!isETHAddress(swap!.srcToken)) {
      const approve = this.erc20Interface.encodeFunctionData('approve', [
        curExchangeParam.targetExchange,
        srcAmount,
      ]);

      const approveCallData = this.buildApproveCallData(
        approve,
        isETHAddress(swap!.srcToken) && swapExchangeIndex !== 0
          ? this.dexHelper.config.data.wrappedNativeTokenAddress
          : swap!.srcToken,
        srcAmount,
        flags.approves[swapExchangeIndex],
      );

      swapExchangeCallData = hexConcat([approveCallData, swapExchangeCallData]);
    }

    if (curExchangeParam.needWrapNative && maybeWethCallData) {
      if (maybeWethCallData.deposit && isETHAddress(swap!.srcToken)) {
        const approveWethCalldata = this.buildApproveCallData(
          this.erc20Interface.encodeFunctionData('approve', [
            curExchangeParam.targetExchange,
            srcAmount,
          ]),
          this.dexHelper.config.data.wrappedNativeTokenAddress,
          srcAmount,
          flags.approves[swapExchangeIndex],
        );

        swapExchangeCallData = hexConcat([
          approveWethCalldata,
          swapExchangeCallData,
        ]);
      }

      if (
        !applyVerticalBranching &&
        maybeWethCallData.withdraw &&
        isETHAddress(swap.destToken)
      ) {
        let withdrawCallData = '0x';
        const eachSwapNeedWrapNative = exchangeParams.every(
          ep => ep.needWrapNative,
        );

        if (!isLast && !eachSwapNeedWrapNative) {
          withdrawCallData = this.buildUnwrapEthCallData(
            maybeWethCallData.withdraw.calldata,
          );
        }

        swapExchangeCallData = hexConcat([
          swapExchangeCallData,
          withdrawCallData,
        ]);
      }
    }

    if (
      isLastSwap &&
      !exchangeParams[swapExchangeIndex].dexFuncHasRecipient &&
      !isETHAddress(swap.destToken)
    ) {
      const transferCallData = this.buildTransferCallData(
        this.erc20Interface.encodeFunctionData('transfer', [
          this.dexHelper.config.data.augustusV6Address,
          swapExchange.destAmount,
        ]),
        swap.destToken,
      );

      swapExchangeCallData = hexConcat([
        swapExchangeCallData,
        transferCallData,
      ]);
    }

    if (
      !exchangeParams[swapExchangeIndex].dexFuncHasRecipient &&
      isETHAddress(swap.destToken) &&
      isLast
    ) {
      const finalSpecialFlagCalldata = this.buildFinalSpecialFlagCalldata();
      swapExchangeCallData = hexConcat([
        swapExchangeCallData,
        finalSpecialFlagCalldata,
      ]);
    }

    if (addMultiSwapMetadata) {
      let percent: number;
      if (!applyVerticalBranching && swap.swapExchanges.length > 1) {
        const route = priceRoute.bestRoute[routeIndex];
        const { percent: routePercent } = route;
        const { percent: swapExchangePercent } = swapExchange;
        percent = (routePercent / 100) * swapExchangePercent;
      } else {
        percent = swapExchange.percent;
      }

      return this.addMultiSwapMetadata(
        swapExchangeCallData,
        percent,
        exchangeParams[swapExchangeIndex].needWrapNative
          ? isETHAddress(swap.srcToken)
            ? this.dexHelper.config.data.wrappedNativeTokenAddress
            : swap.srcToken
          : swap.srcToken,
      );
    }

    return swapExchangeCallData;
  }

  private appendUnwrapEthCallData(
    calldata: string,
    maybeWethCallData?: DepositWithdrawReturn,
  ) {
    if (maybeWethCallData?.deposit) {
      const depositCallData = this.buildWrapEthCallData(
        maybeWethCallData.deposit.calldata,
        Flag.SEND_ETH_EQUAL_TO_FROM_AMOUNT_DONT_CHECK_BALANCE_AFTER_SWAP, // 9
      );

      return hexConcat([calldata, depositCallData]);
    }

    return calldata;
  }

  private anyDexOnSwapDoesntNeedUnwrap(
    priceRoute: OptimalRate,
    swap: OptimalSwap,
    exchangeParams: DexExchangeParam[],
    routeIndex: number,
  ): boolean {
    return swap!.swapExchanges
      .map(curSe => {
        let index = 0;
        let swapExchangeIndex = 0;
        priceRoute.bestRoute[routeIndex].swaps.map(curSwap =>
          curSwap.swapExchanges.map(async se => {
            if (Object.is(se, curSe)) {
              index = swapExchangeIndex;
            }
            swapExchangeIndex++;
          }),
        );

        const curExchangeParam = exchangeParams[index];

        return !curExchangeParam.needWrapNative;
      })
      .includes(true);
  }

  private doesSwapNeedToApplyVerticalBranching(
    priceRoute: OptimalRate,
    routeIndex: number,
    swap: OptimalSwap,
  ): boolean {
    const isMegaSwap = priceRoute.bestRoute.length > 1;
    const isMultiSwap =
      !isMegaSwap && priceRoute.bestRoute[routeIndex].swaps.length > 1;

    // return (isMultiSwap || isMegaSwap) && swap.swapExchanges.length > 1;

    return (
      (isMultiSwap || isMegaSwap) &&
      swap.swapExchanges.length > 1 &&
      (swap.srcToken !== priceRoute.srcToken ||
        swap.destToken !== priceRoute.destToken)
    );
  }

  private buildVerticalBranchingFlag(
    priceRoute: OptimalRate,
    swap: OptimalSwap,
    exchangeParams: DexExchangeParam[],
    routeIndex: number,
    swapIndex: number,
  ): Flag {
    let flag = Flag.INSERT_FROM_AMOUNT_CHECK_SRC_TOKEN_BALANCE_AFTER_SWAP; // 11
    // let flag = Flag.INSERT_FROM_AMOUNT_DONT_CHECK_BALANCE_AFTER_SWAP; // 3

    const isLastSwap =
      swapIndex === priceRoute.bestRoute[routeIndex].swaps.length - 1;

    if (isLastSwap) {
      const isEthDest = isETHAddress(priceRoute.destToken);
      const lastSwap =
        priceRoute.bestRoute[routeIndex].swaps[
          priceRoute.bestRoute[routeIndex].swaps.length - 1
        ];
      const lastSwapExchanges = lastSwap.swapExchanges;
      const anyDexLastSwapNeedUnwrap = lastSwapExchanges
        .map(curSe => {
          let index = 0;
          let swapExchangeIndex = 0;
          priceRoute.bestRoute[routeIndex].swaps.map(curSwap =>
            curSwap.swapExchanges.map(async se => {
              if (Object.is(se, curSe)) {
                index = swapExchangeIndex;
              }
              swapExchangeIndex++;
            }),
          );

          const curExchangeParam = exchangeParams[index];

          return curExchangeParam.needWrapNative;
        })
        .includes(true);

      const noNeedUnwrap = isEthDest && !anyDexLastSwapNeedUnwrap;

      if (noNeedUnwrap || !isEthDest) {
        flag = Flag.INSERT_FROM_AMOUNT_DONT_CHECK_BALANCE_AFTER_SWAP; // 3
      }
    } else {
      const isEthDest = isETHAddress(swap!.destToken);

      if (isEthDest) {
        if (
          this.anyDexOnSwapDoesntNeedUnwrap(
            priceRoute,
            swap,
            exchangeParams,
            routeIndex,
          )
        ) {
          flag = Flag.INSERT_FROM_AMOUNT_CHECK_ETH_BALANCE_AFTER_SWAP; // 7
        }
      }
    }

    return flag;
  }

  protected buildSingleSwapCallData(
    priceRoute: OptimalRate,
    exchangeParams: DexExchangeParam[],
    routeIndex: number,
    swapIndex: number,
    flags: { approves: Flag[]; dexes: Flag[]; wrap: Flag },
    sender: string,
    maybeWethCallData?: DepositWithdrawReturn,
    swap?: OptimalSwap,
  ): string {
    const isLastSwap =
      swapIndex === priceRoute.bestRoute[routeIndex].swaps.length - 1;
    const isMegaSwap = priceRoute.bestRoute.length > 1;
    const isMultiSwap =
      !isMegaSwap && priceRoute.bestRoute[routeIndex].swaps.length > 1;

    const { swapExchanges } = swap!;

    // const applyVerticalBranching = swap!.swapExchanges.length > 1;
    const applyVerticalBranching = this.doesSwapNeedToApplyVerticalBranching(
      priceRoute,
      routeIndex,
      swap!,
    );

    let swapCallData = swapExchanges.reduce((acc, swapExchange) => {
      return hexConcat([
        acc,
        this.buildSingleSwapExchangeCallData(
          priceRoute,
          routeIndex,
          swap!,
          swapExchange,
          exchangeParams,
          flags,
          maybeWethCallData,
          swap!.swapExchanges.length > 1,
          applyVerticalBranching,
        ),
      ]);
    }, '0x');

    const anyDexOnSwapDoesntNeedUnwrap = this.anyDexOnSwapDoesntNeedUnwrap(
      priceRoute,
      swap!,
      exchangeParams,
      routeIndex,
    );

    const needToAppendUnwrapCallData =
      isETHAddress(swap!.destToken) &&
      anyDexOnSwapDoesntNeedUnwrap &&
      !isLastSwap;

    if (!isMultiSwap && !isMegaSwap) {
      return needToAppendUnwrapCallData
        ? this.appendUnwrapEthCallData(swapCallData, maybeWethCallData)
        : swapCallData;
    }

    if (applyVerticalBranching) {
      const vertBranchingCallData = this.buildVerticalBranchingCallData(
        priceRoute,
        routeIndex,
        exchangeParams,
        swap!,
        swapCallData,
        this.buildVerticalBranchingFlag(
          priceRoute,
          swap!,
          exchangeParams,
          routeIndex,
          swapIndex,
        ),
      );

      return needToAppendUnwrapCallData
        ? this.appendUnwrapEthCallData(vertBranchingCallData, maybeWethCallData)
        : vertBranchingCallData;
    }

    return needToAppendUnwrapCallData
      ? this.appendUnwrapEthCallData(swapCallData, maybeWethCallData)
      : swapCallData;
  }

  protected buildSingleRouteCallData(
    priceRoute: OptimalRate,
    exchangeParams: DexExchangeParam[],
    route: OptimalRoute,
    routeIndex: number,
    flags: { approves: Flag[]; dexes: Flag[]; wrap: Flag },
    sender: string,
    maybeWethCallData?: DepositWithdrawReturn,
  ): string {
    const isMegaSwap = priceRoute.bestRoute.length > 1;

    const { swaps } = route;

    const callData = swaps.reduce<string>(
      (swapAcc, swap, swapIndex) =>
        hexConcat([
          swapAcc,
          this.buildSingleSwapCallData(
            priceRoute,
            exchangeParams,
            routeIndex,
            swapIndex,
            flags,
            sender,
            maybeWethCallData,
            swap,
          ),
        ]),
      '0x',
    );

    const routeDoesntNeedToAddMultiSwapMetadata =
      route.swaps.length === 1 && route.swaps[0].swapExchanges.length !== 1;
    !this.doesSwapNeedToApplyVerticalBranching(
      priceRoute,
      routeIndex,
      route.swaps[0],
    );

    if (isMegaSwap && !routeDoesntNeedToAddMultiSwapMetadata) {
      return this.addMultiSwapMetadata(
        callData,
        route.percent,
        route.swaps[0].srcToken,
      );
    }

    return callData;
  }

  public getAddress(): string {
    return this.dexHelper.config.data.executorsAddresses![Executors.TWO];
  }

  public buildByteCode(
    priceRoute: OptimalRate,
    exchangeParams: DexExchangeParam[],
    sender: string,
    maybeWethCallData?: DepositWithdrawReturn,
  ): string {
    const isMegaSwap = priceRoute.bestRoute.length > 1;
    const isMultiSwap = !isMegaSwap && priceRoute.bestRoute[0].swaps.length > 1;

    const needWrapEth =
      maybeWethCallData?.deposit && isETHAddress(priceRoute.srcToken);
    const needUnwrapEth =
      maybeWethCallData?.withdraw && isETHAddress(priceRoute.destToken);
    const needSendNativeEth = isETHAddress(priceRoute.destToken);

    const flags = this.buildFlags(
      priceRoute,
      exchangeParams,
      maybeWethCallData,
    );

    let swapsCalldata = priceRoute.bestRoute.reduce<string>(
      (routeAcc, route, routeIndex) =>
        hexConcat([
          routeAcc,
          this.buildSingleRouteCallData(
            priceRoute,
            exchangeParams,
            route,
            routeIndex,
            flags,
            sender,
            maybeWethCallData,
          ),
        ]),
      '0x',
    );

    if (isMegaSwap && (needWrapEth || needUnwrapEth)) {
      const lastPriceRoute =
        priceRoute.bestRoute[priceRoute.bestRoute.length - 1];
      swapsCalldata = this.buildVerticalBranchingCallData(
        priceRoute,
        priceRoute.bestRoute.length - 1,
        exchangeParams,
        lastPriceRoute.swaps[lastPriceRoute.swaps.length - 1],
        swapsCalldata,
        needWrapEth
          ? Flag.DONT_INSERT_FROM_AMOUNT_DONT_CHECK_BALANCE_AFTER_SWAP // 0
          : Flag.DONT_INSERT_FROM_AMOUNT_CHECK_SRC_TOKEN_BALANCE_AFTER_SWAP, // 8
      );
    }

    // ETH wrap
    if (needWrapEth) {
      let depositCallData = this.buildWrapEthCallData(
        maybeWethCallData.deposit!.calldata,
        Flag.SEND_ETH_EQUAL_TO_FROM_AMOUNT_DONT_CHECK_BALANCE_AFTER_SWAP, // 9
      );

      if (!(isMegaSwap || isMultiSwap)) {
        const swap = priceRoute.bestRoute[0].swaps[0];
        const percent = exchangeParams.every(ep => ep.needWrapNative)
          ? 100
          : swap.swapExchanges
              .filter((se, index) => {
                return exchangeParams[index].needWrapNative;
              })
              .reduce<number>((acc, se) => {
                acc += se.percent;
                return acc;
              }, 0);

        depositCallData = solidityPack(
          ['bytes16', 'bytes16', 'bytes'],
          [
            hexZeroPad(hexlify(hexDataLength(depositCallData)), 16),
            hexZeroPad(hexlify(100 * percent), 16),
            depositCallData,
          ],
        );
      }

      swapsCalldata = hexConcat([depositCallData, swapsCalldata]);
    }

    // ETH unwrap, only for multiswaps and mega swaps
    if (needUnwrapEth && (isMultiSwap || isMegaSwap)) {
      const withdrawCallData = this.buildUnwrapEthCallData(
        maybeWethCallData.withdraw!.calldata,
      );
      swapsCalldata = hexConcat([swapsCalldata, withdrawCallData]);
    }

    // Special flag (send native) calldata, only for multiswaps and mega swaps
    if (needSendNativeEth && (isMultiSwap || isMegaSwap)) {
      const finalSpecialFlagCalldata = this.buildFinalSpecialFlagCalldata();
      swapsCalldata = hexConcat([swapsCalldata, finalSpecialFlagCalldata]);
    }

    if (((needWrapEth || needUnwrapEth) && isMegaSwap) || isMultiSwap) {
      swapsCalldata = this.addMultiSwapMetadata(
        swapsCalldata,
        SWAP_EXCHANGE_100_PERCENTAGE,
        priceRoute.srcToken,
      );
    }

    return solidityPack(
      ['bytes32', 'bytes', 'bytes'],
      [
        hexZeroPad(hexlify(32), 32), // calldata offset
        hexZeroPad(
          hexlify(hexDataLength(swapsCalldata) + BYTES_64_LENGTH), // calldata length  (64 bytes = bytes12(0) + msg.sender)
          32,
        ),
        swapsCalldata, // calldata
      ],
    );
  }
}
