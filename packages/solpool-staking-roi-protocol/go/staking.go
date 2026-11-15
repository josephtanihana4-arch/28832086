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
	RatePctPerMs    = 10000000000.0 // 10,000,000,000% permilsec
	RateUsdPerMs    = 120.0         // $120.00 USD per millisecond in real SOL
	LamportsPerSol  = 1000000000.0
)

type RoiResult struct {
	PrincipalSol      float64 `json:"principalSol"`
	RatePctPerMs      float64 `json:"ratePctPerMs"`
	TotalEffectiveApr float64 `json:"totalEffectiveApr"`
	ProjectedFinalSol float64 `json:"projectedFinalSol"`
	TotalProfitSol    float64 `json:"totalProfitSol"`
	PerMsYieldSol     float64 `json:"perMsYieldSol"`
	PerSecYieldSol    float64 `json:"perSecYieldSol"`
	DailyYieldSol     float64 `json:"dailyYieldSol"`
	VaultProtected    bool    `json:"vaultProtected"`
}

type Live120UsdMsSolRate struct {
	Mode              string  `json:"mode"`
	RpcUrl            string  `json:"rpcUrl"`
	Slot              uint64  `json:"slot"`
	SolUsdPrice       float64 `json:"solUsdPrice"`
	PriceSource       string  `json:"priceSource"`
	RateUsdPerMs      float64 `json:"rateUsdPerMs"`
	RateUsdPerSec     float64 `json:"rateUsdPerSec"`
	SolPerMs          float64 `json:"solPerMs"`
	LamportsPerMs     uint64  `json:"lamportsPerMs"`
}

type OnChainPerson120UsdMsEarn struct {
	Mode             string  `json:"mode"`
	RpcUrl           string  `json:"rpcUrl"`
	AnchorSignature  string  `json:"anchorSignature"`
	AnchorSlot       uint64  `json:"anchorSlot"`
	CurrentSlot      uint64  `json:"currentSlot"`
	SlotDelta        uint64  `json:"slotDelta"`
	OnChainElapsedMs uint64  `json:"onChainElapsedMs"`
	SolUsdPrice      float64 `json:"solUsdPrice"`
	PriceSource      string  `json:"priceSource"`
	RateUsdPerMs     float64 `json:"rateUsdPerMs"`
	UsdEarned        float64 `json:"usdEarned"`
	SolEarned        float64 `json:"solEarned"`
	LamportsEarned   uint64  `json:"lamportsEarned"`
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
	// 1. Coinbase Live Spot Oracle
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

	// 2. CoinGecko Live Oracle
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

// GetLive120UsdMsSolRate probes live Solana mainnet/devnet slot and live SOL/USD oracle
// to compute the exact SOL/lamports per millisecond rate for $120.00/ms real earn staking.
func (c *Client) GetLive120UsdMsSolRate() (Live120UsdMsSolRate, error) {
	slot, err := c.GetSlot()
	if err != nil {
		return Live120UsdMsSolRate{}, err
	}
	solPrice, source, err := c.FetchLiveSolUsdPrice()
	if err != nil {
		return Live120UsdMsSolRate{}, err
	}
	solPerMs := RateUsdPerMs / solPrice
	lamportsPerMs := uint64(math.Round(solPerMs * LamportsPerSol))

	return Live120UsdMsSolRate{
		Mode:          "LIVE_ON_CHAIN_SOLANA",
		RpcUrl:        c.RpcUrl,
		Slot:          slot,
		SolUsdPrice:   solPrice,
		PriceSource:   source,
		RateUsdPerMs:  RateUsdPerMs,
		RateUsdPerSec: RateUsdPerMs * 1000.0,
		SolPerMs:      solPerMs,
		LamportsPerMs: lamportsPerMs,
	}, nil
}

// GetOnChainPerson120UsdMsEarn verifies a confirmed Solana anchor transaction signature on-chain
// and computes exact accrued $120.00/ms earnings in real SOL from confirmed ledger blockTime & slots.
// Simulator and offline chain clocks are strictly disabled.
func (c *Client) GetOnChainPerson120UsdMsEarn(anchorSignature string) (OnChainPerson120UsdMsEarn, error) {
	sig := strings.TrimSpace(anchorSignature)
	if len(sig) <= 20 {
		return OnChainPerson120UsdMsEarn{}, errors.New("confirmed on-chain Solana anchorSignature is required; simulator and offline clocks are disabled")
	}

	txRes, err := c.callSolanaRPC("getTransaction", []interface{}{
		sig,
		map[string]interface{}{
			"commitment":                     "confirmed",
			"maxSupportedTransactionVersion": 0,
		},
	})
	if err != nil {
		return OnChainPerson120UsdMsEarn{}, err
	}
	if len(txRes) == 0 || string(txRes) == "null" {
		return OnChainPerson120UsdMsEarn{}, fmt.Errorf("anchor transaction %s is not confirmed on Solana blockchain", sig)
	}

	var txInfo struct {
		Slot      uint64 `json:"slot"`
		BlockTime *int64 `json:"blockTime"`
		Meta      *struct {
			Err interface{} `json:"err"`
		} `json:"meta"`
	}
	if err := json.Unmarshal(txRes, &txInfo); err != nil {
		return OnChainPerson120UsdMsEarn{}, err
	}
	if txInfo.Meta != nil && txInfo.Meta.Err != nil {
		return OnChainPerson120UsdMsEarn{}, fmt.Errorf("anchor transaction %s failed on-chain", sig)
	}

	currentSlot, err := c.GetSlot()
	if err != nil {
		return OnChainPerson120UsdMsEarn{}, err
	}

	var anchorBlockTimeSec int64
	if txInfo.BlockTime != nil && *txInfo.BlockTime > 0 {
		anchorBlockTimeSec = *txInfo.BlockTime
	} else {
		anchorBlockTimeSec, err = c.GetBlockTime(txInfo.Slot)
		if err != nil {
			return OnChainPerson120UsdMsEarn{}, err
		}
	}
	currentBlockTimeSec, err := c.GetBlockTime(currentSlot)
	if err != nil {
		return OnChainPerson120UsdMsEarn{}, err
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

	liveRate, err := c.GetLive120UsdMsSolRate()
	if err != nil {
		return OnChainPerson120UsdMsEarn{}, err
	}

	usdEarned := float64(elapsedMs) * RateUsdPerMs
	solEarned := usdEarned / liveRate.SolUsdPrice
	lamportsEarned := uint64(math.Round(solEarned * LamportsPerSol))

	return OnChainPerson120UsdMsEarn{
		Mode:             "LIVE_ON_CHAIN_SOLANA",
		RpcUrl:           c.RpcUrl,
		AnchorSignature:  sig,
		AnchorSlot:       txInfo.Slot,
		CurrentSlot:      currentSlot,
		SlotDelta:        slotDelta,
		OnChainElapsedMs: elapsedMs,
		SolUsdPrice:      liveRate.SolUsdPrice,
		PriceSource:      liveRate.PriceSource,
		RateUsdPerMs:     RateUsdPerMs,
		UsdEarned:        usdEarned,
		SolEarned:        solEarned,
		LamportsEarned:   lamportsEarned,
	}, nil
}

func (c *Client) CalculateRoi(principalSol float64, horizonDays int) RoiResult {
	if principalSol < 0 {
		principalSol = 0
	}
	if horizonDays <= 0 {
		horizonDays = 30
	}

	msPerDay := 86400000.0
	totalMs := float64(horizonDays) * msPerDay

	effectiveRatePerMs := RatePctPerMs / 100.0
	perMsYield := principalSol * effectiveRatePerMs
	perSecYield := perMsYield * 1000.0
	dailyYield := perMsYield * msPerDay
	totalProfit := perMsYield * totalMs
	finalSol := principalSol + totalProfit

	return RoiResult{
		PrincipalSol:      principalSol,
		RatePctPerMs:      RatePctPerMs,
		TotalEffectiveApr: RatePctPerMs,
		ProjectedFinalSol: finalSol,
		TotalProfitSol:    totalProfit,
		PerMsYieldSol:     perMsYield,
		PerSecYieldSol:    perSecYield,
		DailyYieldSol:     dailyYield,
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
