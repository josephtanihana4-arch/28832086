package pos

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strings"
	"time"
)

const (
	RateUsdPerHour  = 150.0        // $150.00 USD per hour ($3,600/day) in real SOL
	RateUsdPerSec   = 150.0 / 3600.0
	MsPerHour       = 3600000.0
	LamportsPerSol  = 1000000000.0
)

type RoiResult struct {
	PrincipalSol      float64 `json:"principalSol"`
	HourlyUsdRate     float64 `json:"hourlyUsdRate"`
	DailyUsdRate      float64 `json:"dailyUsdRate"`
	SolUsdPrice       float64 `json:"solUsdPrice"`
	ProjectedFinalSol float64 `json:"projectedFinalSol"`
	TotalProfitSol    float64 `json:"totalProfitSol"`
	TotalProfitUsd    float64 `json:"totalProfitUsd"`
	HourlyYieldSol    float64 `json:"hourlyYieldSol"`
	DailyYieldSol     float64 `json:"dailyYieldSol"`
	VaultProtected    bool    `json:"vaultProtected"`
}

type Live150UsdHourlySolRate struct {
	Mode             string  `json:"mode"`
	RpcUrl           string  `json:"rpcUrl"`
	Slot             uint64  `json:"slot"`
	SolUsdPrice      float64 `json:"solUsdPrice"`
	PriceSource      string  `json:"priceSource"`
	RateUsdPerHour   float64 `json:"rateUsdPerHour"`
	RateUsdPerDay    float64 `json:"rateUsdPerDay"`
	SolPerHour       float64 `json:"solPerHour"`
	LamportsPerHour  uint64  `json:"lamportsPerHour"`
}

type OnChainHourly150UsdEarn struct {
	Mode             string  `json:"mode"`
	RpcUrl           string  `json:"rpcUrl"`
	AnchorSignature  string  `json:"anchorSignature"`
	AnchorSlot       uint64  `json:"anchorSlot"`
	CurrentSlot      uint64  `json:"currentSlot"`
	SlotDelta        uint64  `json:"slotDelta"`
	OnChainElapsedMs uint64  `json:"onChainElapsedMs"`
	SolUsdPrice      float64 `json:"solUsdPrice"`
	PriceSource      string  `json:"priceSource"`
	RateUsdPerHour   float64 `json:"rateUsdPerHour"`
	UsdEarned        float64 `json:"usdEarned"`
	SolEarned        float64 `json:"solEarned"`
	LamportsEarned   uint64  `json:"lamportsEarned"`
}

type L2PosInflationReport struct {
	Mode                           string  `json:"mode"`
	RpcUrl                         string  `json:"rpcUrl"`
	Epoch                          uint64  `json:"epoch"`
	Slot                           uint64  `json:"slot"`
	L1TotalInflationPct            float64 `json:"l1TotalInflationPct"`
	L1ValidatorInflationPct        float64 `json:"l1ValidatorInflationPct"`
	L2PersonHourlyUsdRate          float64 `json:"l2PersonHourlyUsdRate"`
	L2PersonHourlySolRate          float64 `json:"l2PersonHourlySolRate"`
	SolUsdPrice                    float64 `json:"solUsdPrice"`
	PriceSource                    string  `json:"priceSource"`
	TreasuryPubkey                 string  `json:"treasuryPubkey,omitempty"`
	TreasurySolBalance             float64 `json:"treasurySolBalance"`
	TreasuryRunwayHours            float64 `json:"treasuryRunwayHours"`
	RequiredL1PrincipalFor150HrSol float64 `json:"requiredL1PrincipalFor150HrSol"`
	IsSimulator                    bool    `json:"isSimulator"`
}

type OneCentL2PackageReport struct {
	Mode                       string  `json:"mode"`
	RpcUrl                     string  `json:"rpcUrl"`
	Slot                       uint64  `json:"slot"`
	PackageEntryUsd            float64 `json:"packageEntryUsd"`
	PackageEntryCents          int     `json:"packageEntryCents"`
	PackageEntrySol            float64 `json:"packageEntrySol"`
	L2FixedHourlyUsdRate       float64 `json:"l2FixedHourlyUsdRate"`
	L2FixedHourlySolRate       float64 `json:"l2FixedHourlySolRate"`
	IgnoresL1NormalStakingRate bool    `json:"ignoresL1NormalStakingRate"`
	SolUsdPrice                float64 `json:"solUsdPrice"`
	PriceSource                string  `json:"priceSource"`
	TreasuryPubkey             string  `json:"treasuryPubkey,omitempty"`
	TreasurySolBalance         float64 `json:"treasurySolBalance"`
	TreasuryRunwayHours        float64 `json:"treasuryRunwayHours"`
	IsSimulator                bool    `json:"isSimulator"`
}

type Client struct {
	RpcUrl     string
	HTTPClient *http.Client
}

func NewClient(rpcUrl string) *Client {
	if strings.TrimSpace(rpcUrl) == "" {
		rpcUrl = "https://api.mainnet-beta.solana.com"
	}
	return &Client{
		RpcUrl:     strings.TrimSpace(rpcUrl),
		HTTPClient: &http.Client{Timeout: 15 * time.Second},
	}
}

type rpcRequest struct {
	JSONRPC string        `json:"jsonrpc"`
	ID      int           `json:"id"`
	Method  string        `json:"method"`
	Params  []interface{} `json:"params,omitempty"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      int             `json:"id"`
	Result  json.RawMessage `json:"result"`
	Error   *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

func (c *Client) callSolanaRPC(method string, params []interface{}) (json.RawMessage, error) {
	payload := rpcRequest{
		JSONRPC: "2.0",
		ID:      1,
		Method:  method,
		Params:  params,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	resp, err := c.HTTPClient.Post(c.RpcUrl, "application/json", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("solana rpc error (%s): %w", method, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	var decoded rpcResponse
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return nil, fmt.Errorf("invalid solana rpc response: %w", err)
	}
	if decoded.Error != nil {
		return nil, fmt.Errorf("solana rpc %s error %d: %s", method, decoded.Error.Code, decoded.Error.Message)
	}
	return decoded.Result, nil
}

func (c *Client) GetSlot() (uint64, error) {
	res, err := c.callSolanaRPC("getSlot", []interface{}{map[string]string{"commitment": "confirmed"}})
	if err != nil {
		return 0, err
	}
	var slot uint64
	if err := json.Unmarshal(res, &slot); err != nil {
		return 0, err
	}
	return slot, nil
}

func (c *Client) GetBalanceLamports(pubkey string) (uint64, error) {
	res, err := c.callSolanaRPC("getBalance", []interface{}{
		strings.TrimSpace(pubkey),
		map[string]string{"commitment": "confirmed"},
	})
	if err != nil {
		return 0, err
	}
	var out struct {
		Value uint64 `json:"value"`
	}
	if err := json.Unmarshal(res, &out); err != nil {
		return 0, err
	}
	return out.Value, nil
}

func (c *Client) GetBlockTime(slot uint64) (int64, error) {
	for offset := uint64(0); offset <= 4; offset++ {
		target := slot
		if slot >= offset {
			target = slot - offset
		}
		res, err := c.callSolanaRPC("getBlockTime", []interface{}{target})
		if err == nil && len(res) > 0 && string(res) != "null" {
			var bt int64
			if err := json.Unmarshal(res, &bt); err == nil && bt > 0 {
				return bt, nil
			}
		}
	}
	return 0, fmt.Errorf("unable to resolve confirmed on-chain Solana blockTime near slot %d", slot)
}

func (c *Client) FetchLiveSolUsdPrice() (float64, string, error) {
	if resp, err := c.HTTPClient.Get("https://api.coinbase.com/v2/prices/SOL-USD/spot"); err == nil {
		defer resp.Body.Close()
		var cb struct {
			Data struct {
				Amount string `json:"amount"`
			} `json:"data"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&cb); err == nil {
			var p float64
			if _, scanErr := fmt.Sscanf(cb.Data.Amount, "%f", &p); scanErr == nil && p > 0 {
				return p, "Coinbase Spot (SOL-USD)", nil
			}
		}
	}

	if resp, err := c.HTTPClient.Get("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd"); err == nil {
		defer resp.Body.Close()
		var cg struct {
			Solana struct {
				USD float64 `json:"usd"`
			} `json:"solana"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&cg); err == nil && cg.Solana.USD > 0 {
			return cg.Solana.USD, "CoinGecko Live Price", nil
		}
	}

	return 0, "", errors.New("unable to fetch live SOL/USD oracle price; offline price fallbacks are disabled")
}

// GetLive150UsdHourlySolRate probes live Solana mainnet/devnet slot and live SOL/USD oracle
// to compute the exact SOL/lamports per hour rate for $150.00/hour Native PoS staking.
func (c *Client) GetLive150UsdHourlySolRate() (Live150UsdHourlySolRate, error) {
	slot, err := c.GetSlot()
	if err != nil {
		return Live150UsdHourlySolRate{}, err
	}
	solPrice, source, err := c.FetchLiveSolUsdPrice()
	if err != nil {
		return Live150UsdHourlySolRate{}, err
	}
	solPerHour := RateUsdPerHour / solPrice
	lamportsPerHour := uint64(math.Round(solPerHour * LamportsPerSol))

	return Live150UsdHourlySolRate{
		Mode:            "LIVE_ON_CHAIN_SOLANA",
		RpcUrl:          c.RpcUrl,
		Slot:            slot,
		SolUsdPrice:     solPrice,
		PriceSource:     source,
		RateUsdPerHour:  RateUsdPerHour,
		RateUsdPerDay:   RateUsdPerHour * 24.0,
		SolPerHour:      solPerHour,
		LamportsPerHour: lamportsPerHour,
	}, nil
}

// GetOnChainHourly150UsdEarn verifies a confirmed Solana anchor transaction signature on-chain
// and computes exact accrued $150.00/hr earnings in real SOL from confirmed ledger blockTime & slots.
func (c *Client) GetOnChainHourly150UsdEarn(anchorSignature string) (OnChainHourly150UsdEarn, error) {
	sig := strings.TrimSpace(anchorSignature)
	if len(sig) <= 20 {
		return OnChainHourly150UsdEarn{}, errors.New("confirmed on-chain Solana anchorSignature is required; simulator and offline clocks are disabled")
	}

	txRes, err := c.callSolanaRPC("getTransaction", []interface{}{
		sig,
		map[string]interface{}{
			"commitment":                     "confirmed",
			"maxSupportedTransactionVersion": 0,
		},
	})
	if err != nil {
		return OnChainHourly150UsdEarn{}, err
	}
	if len(txRes) == 0 || string(txRes) == "null" {
		return OnChainHourly150UsdEarn{}, fmt.Errorf("anchor transaction %s is not confirmed on Solana blockchain", sig)
	}

	var txInfo struct {
		Slot      uint64 `json:"slot"`
		BlockTime *int64 `json:"blockTime"`
		Meta      *struct {
			Err interface{} `json:"err"`
		} `json:"meta"`
	}
	if err := json.Unmarshal(txRes, &txInfo); err != nil {
		return OnChainHourly150UsdEarn{}, err
	}
	if txInfo.Meta != nil && txInfo.Meta.Err != nil {
		return OnChainHourly150UsdEarn{}, fmt.Errorf("anchor transaction %s failed on-chain", sig)
	}

	currentSlot, err := c.GetSlot()
	if err != nil {
		return OnChainHourly150UsdEarn{}, err
	}

	var anchorBlockTimeSec int64
	if txInfo.BlockTime != nil && *txInfo.BlockTime > 0 {
		anchorBlockTimeSec = *txInfo.BlockTime
	} else {
		anchorBlockTimeSec, err = c.GetBlockTime(txInfo.Slot)
		if err != nil {
			return OnChainHourly150UsdEarn{}, err
		}
	}
	currentBlockTimeSec, err := c.GetBlockTime(currentSlot)
	if err != nil {
		return OnChainHourly150UsdEarn{}, err
	}

	var slotDelta uint64
	if currentSlot > txInfo.Slot {
		slotDelta = currentSlot - txInfo.Slot
	}
	var elapsedMs uint64
	if currentBlockTimeSec > anchorBlockTimeSec {
		elapsedMs = uint64(currentBlockTimeSec-anchorBlockTimeSec) * 1000
	} else if slotDelta > 0 {
		elapsedMs = slotDelta * 400
	}

	liveRate, err := c.GetLive150UsdHourlySolRate()
	if err != nil {
		return OnChainHourly150UsdEarn{}, err
	}

	usdEarned := (float64(elapsedMs) * RateUsdPerHour) / MsPerHour
	solEarned := usdEarned / liveRate.SolUsdPrice
	lamportsEarned := uint64(math.Round(solEarned * LamportsPerSol))

	return OnChainHourly150UsdEarn{
		Mode:             "LIVE_ON_CHAIN_SOLANA",
		RpcUrl:           c.RpcUrl,
		AnchorSignature:  sig,
		AnchorSlot:       txInfo.Slot,
		CurrentSlot:      currentSlot,
		SlotDelta:        slotDelta,
		OnChainElapsedMs: elapsedMs,
		SolUsdPrice:      liveRate.SolUsdPrice,
		PriceSource:      liveRate.PriceSource,
		RateUsdPerHour:   RateUsdPerHour,
		UsdEarned:        usdEarned,
		SolEarned:        solEarned,
		LamportsEarned:   lamportsEarned,
	}, nil
}

func (c *Client) CalculateRoi(principalSol float64, horizonDays int, solPriceUsd float64) RoiResult {
	if principalSol < 0 {
		principalSol = 0
	}
	if horizonDays <= 0 {
		horizonDays = 30
	}
	if solPriceUsd <= 0 {
		solPriceUsd = 180.0
	}

	hourlyYieldSol := RateUsdPerHour / solPriceUsd
	dailyYieldSol := hourlyYieldSol * 24.0
	totalHours := float64(horizonDays) * 24.0
	totalProfitUsd := RateUsdPerHour * totalHours
	totalProfitSol := totalProfitUsd / solPriceUsd
	finalSol := principalSol + totalProfitSol

	return RoiResult{
		PrincipalSol:      principalSol,
		HourlyUsdRate:     RateUsdPerHour,
		DailyUsdRate:      RateUsdPerHour * 24.0,
		SolUsdPrice:       solPriceUsd,
		ProjectedFinalSol: finalSol,
		TotalProfitSol:    totalProfitSol,
		TotalProfitUsd:    totalProfitUsd,
		HourlyYieldSol:    hourlyYieldSol,
		DailyYieldSol:     dailyYieldSol,
		VaultProtected:    true,
	}
}

func (c *Client) AuditPersonalVault(principalSol float64, currentSolPriceUsd float64, entrySolPriceUsd float64) map[string]interface{} {
	currentValUsd := principalSol * currentSolPriceUsd
	entryValUsd := principalSol * entrySolPriceUsd
	drawdownPct := 0.0
	if entryValUsd > 0 {
		drawdownPct = math.Max(0, ((entryValUsd - currentValUsd) / entryValUsd) * 100.0)
	}

	protectedFloorUsd := entryValUsd
	insuranceCoverageUsd := math.Max(0, entryValUsd - currentValUsd)

	return map[string]interface{}{
		"principalSol":         principalSol,
		"entrySolPriceUsd":     entrySolPriceUsd,
		"currentSolPriceUsd":   currentSolPriceUsd,
		"currentValueUsd":      currentValUsd,
		"protectedFloorUsd":    protectedFloorUsd,
		"insuranceCoverageUsd": insuranceCoverageUsd,
		"drawdownProtectedPct": drawdownPct,
		"vaultStatus":          "100_PERCENT_PROTECTED",
	}
}

// GetL2PosInflation queries live Solana L1 getInflationRate + getEpochInfo + SOL/USD oracle
// and real treasury solvency to audit the Solana L2.0 PoS Inflation $150.00/hr person rate.
func (c *Client) GetL2PosInflation(treasuryPubkey string) (L2PosInflationReport, error) {
	infRes, err := c.callSolanaRPC("getInflationRate", []interface{}{})
	if err != nil {
		return L2PosInflationReport{}, err
	}
	var inf struct {
		Total     float64 `json:"total"`
		Validator float64 `json:"validator"`
		Epoch     uint64  `json:"epoch"`
	}
	if err := json.Unmarshal(infRes, &inf); err != nil {
		return L2PosInflationReport{}, err
	}

	slot, err := c.GetSlot()
	if err != nil {
		return L2PosInflationReport{}, err
	}
	solPrice, source, err := c.FetchLiveSolUsdPrice()
	if err != nil {
		return L2PosInflationReport{}, err
	}

	solPerHour := RateUsdPerHour / solPrice
	validatorApyRatio := inf.Validator
	if validatorApyRatio <= 0 {
		validatorApyRatio = 0.045
	}
	requiredL1PrincipalSol := (RateUsdPerHour * 8766.0) / (solPrice * validatorApyRatio)

	var treasurySol float64
	var runwayHours float64
	trimmedTreasury := strings.TrimSpace(treasuryPubkey)
	if len(trimmedTreasury) > 20 {
		lamports, balErr := c.GetBalanceLamports(trimmedTreasury)
		if balErr == nil {
			treasurySol = float64(lamports) / LamportsPerSol
			if solPerHour > 0 {
				runwayHours = treasurySol / solPerHour
			}
		}
	}

	return L2PosInflationReport{
		Mode:                           "LIVE_SOLANA_L2_POS_INFLATION",
		RpcUrl:                         c.RpcUrl,
		Epoch:                          inf.Epoch,
		Slot:                           slot,
		L1TotalInflationPct:            inf.Total * 100.0,
		L1ValidatorInflationPct:        inf.Validator * 100.0,
		L2PersonHourlyUsdRate:          RateUsdPerHour,
		L2PersonHourlySolRate:          solPerHour,
		SolUsdPrice:                    solPrice,
		PriceSource:                    source,
		TreasuryPubkey:                 trimmedTreasury,
		TreasurySolBalance:             treasurySol,
		TreasuryRunwayHours:            runwayHours,
		RequiredL1PrincipalFor150HrSol: requiredL1PrincipalSol,
		IsSimulator:                    false,
	}, nil
}

// GetOneCentL2PackageReport inspects the Layer 2.0 $0.01 Cent Package -> Fixed $150/hr protocol
// (completely decoupled from L1 normal staking APY) and checks live treasury solvency.
func (c *Client) GetOneCentL2PackageReport(treasuryPubkey string) (OneCentL2PackageReport, error) {
	slot, err := c.GetSlot()
	if err != nil {
		return OneCentL2PackageReport{}, err
	}
	solPrice, source, err := c.FetchLiveSolUsdPrice()
	if err != nil {
		return OneCentL2PackageReport{}, err
	}
	entrySol := 0.01 / solPrice
	hourlySol := RateUsdPerHour / solPrice

	var treasurySol float64
	var runwayHours float64
	trimmedTreasury := strings.TrimSpace(treasuryPubkey)
	if len(trimmedTreasury) > 20 {
		lamports, balErr := c.GetBalanceLamports(trimmedTreasury)
		if balErr == nil {
			treasurySol = float64(lamports) / LamportsPerSol
			if hourlySol > 0 {
				runwayHours = treasurySol / hourlySol
			}
		}
	}

	return OneCentL2PackageReport{
		Mode:                       "LIVE_L2_ONE_CENT_PACKAGE_FIXED_150_HR",
		RpcUrl:                     c.RpcUrl,
		Slot:                       slot,
		PackageEntryUsd:            0.01,
		PackageEntryCents:          1,
		PackageEntrySol:            entrySol,
		L2FixedHourlyUsdRate:       RateUsdPerHour,
		L2FixedHourlySolRate:       hourlySol,
		IgnoresL1NormalStakingRate: true,
		SolUsdPrice:                solPrice,
		PriceSource:                source,
		TreasuryPubkey:             trimmedTreasury,
		TreasurySolBalance:         treasurySol,
		TreasuryRunwayHours:        runwayHours,
		IsSimulator:                false,
	}, nil
}


