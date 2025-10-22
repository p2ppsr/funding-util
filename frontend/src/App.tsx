// App.tsx
import { useEffect, useMemo, useState } from 'react'
import './App.css'
import {
  WalletClient, P2PKH, Utils, PushDrop, LockingScript,
  ProtoWallet, PublicKey, Random, Transaction, type WalletProtocol
} from '@bsv/sdk'

interface Slip {
  prefix: string
  suffix: string
  used: boolean
  address: string
  hashHex: string
  memo: string
  tokenKey: string
  tokenTxid: string
  tokenOutputIndex: number
  tokenBEEF: number[]
}

const SLIP_DROP = { prefix: 0, suffix: 1, used: 2, memo: 3 }
const SLIP_PROTOCOL: WalletProtocol = [2, 'deposit slip']

const wallet = new WalletClient()
const anyone = new ProtoWallet('anyone')

type Tab = 'outgoing' | 'incoming'

function App() {
  // ----- Outgoing tab (unchanged logic)
  const [sendToAddress, setSendToAddress] = useState('')
  const [sendAmount, setSendAmount] = useState('')
  const [sentAtomicBEEF, setSentAtomicBEEF] = useState('')
  const [isSending, setIsSending] = useState(false)
  const [copied, setCopied] = useState<null | 'atom' | 'addr' | `slip-${number}`>(null)
  const [error, setError] = useState<string | null>(null)

  // ----- Incoming tab (new UI around your existing logic)
  const [depositSlips, setDepositSlips] = useState<Array<Slip>>([])
  const [newSlipMemo, setNewSlipMemo] = useState('')
  const [incomingBEEFs, setIncomingBEEFs] = useState('') // global textarea for Atomic BEEF values
  const [isDepositing, setIsDepositing] = useState(false)

  // ----- Global UI
  const [tab, setTab] = useState<Tab>('outgoing')

  // Load/parse existing slips from basket
  useEffect(() => {
    ;(async () => {
      try {
        const { outputs, BEEF } = await wallet.listOutputs({
          basket: 'deposit slips',
          include: 'entire transactions',
          includeCustomInstructions: true,
          limit: 1000
        })
        const parsed: Array<Slip> = []
        const { publicKey: me } = await wallet.getPublicKey({ identityKey: true })

        for (const o of outputs) {
          try {
            const [tokenTxid, tokenOutputIndex] = o.outpoint.split('.')
            const { tokenKey } = JSON.parse(o.customInstructions as string)
            const tx = Transaction.fromBEEF(BEEF as number[], tokenTxid)
            const script = tx.outputs[Number(tokenOutputIndex)].lockingScript as LockingScript
            const { fields } = PushDrop.decode(script)

            const prefix = Utils.toBase64(fields[SLIP_DROP.prefix])
            const suffix = Utils.toBase64(fields[SLIP_DROP.suffix])
            const { publicKey } = await anyone.getPublicKey({
              protocolID: [2, '3241645161d8'],
              keyID: `${prefix} ${suffix}`,
              counterparty: me
            })
            const derivedPK = PublicKey.fromString(publicKey)
            const hashHex = derivedPK.toHash('hex') as string

            parsed.push({
              prefix,
              suffix,
              used: fields[SLIP_DROP.used][0] !== 0,
              address: derivedPK.toAddress(),
              hashHex,
              memo: Utils.toUTF8(fields[SLIP_DROP.memo]),
              tokenKey,
              tokenTxid,
              tokenOutputIndex: Number(tokenOutputIndex),
              tokenBEEF: tx.toAtomicBEEF()
            })
          } catch (e: unknown) {
            console.error(e)
            // ignore malformed
          }
        }
        setDepositSlips(parsed)
      } catch (e: any) {
        setError(e?.message || 'Failed to list deposit slips.')
      }
    })()
  }, [])

  // Create deposit slip (keeps your logic)
  const createDepositSlip = async (memo: string = '') => {
    try {
      const prefix = Random(32)
      const suffix = Random(32)
      const tokenKey = Utils.toBase64(Random(32))

      const script = await new PushDrop(wallet).lock(
        [prefix, suffix, [0], Utils.toArray(memo, 'utf8')],
        SLIP_PROTOCOL,
        tokenKey,
        'self'
      )

      const { txid, tx } = await wallet.createAction({
        description: 'Create deposit slip',
        outputs: [{
          outputDescription: 'Deposit slip',
          satoshis: 1,
          lockingScript: script.toHex(),
          basket: 'deposit slips',
          customInstructions: JSON.stringify({ tokenKey })
        }],
        options: { acceptDelayedBroadcast: false, randomizeOutputs: false }
      })

      const prefixStr = Utils.toBase64(prefix)
      const suffixStr = Utils.toBase64(suffix)
      const { publicKey: me } = await wallet.getPublicKey({ identityKey: true })
      const { publicKey } = await anyone.getPublicKey({
        protocolID: [2, '3241645161d8'],
        keyID: `${prefixStr} ${suffixStr}`,
        counterparty: me
      })
      const derivedPK = PublicKey.fromString(publicKey)
      const hashHex = derivedPK.toHash('hex') as string

      setDepositSlips((old) => [
        ...old,
        {
          prefix: prefixStr,
          suffix: suffixStr,
          used: false,
          memo,
          tokenKey,
          address: derivedPK.toAddress(),
          hashHex,
          tokenTxid: txid as string,
          tokenOutputIndex: 0,
          tokenBEEF: tx as number[]
        }
      ])
      setNewSlipMemo('')
    } catch (e: any) {
      setError(e?.message || 'Failed to create deposit slip.')
    }
  }

  const markSlipAsUsed = async (slip: Slip) => {
    const newSlipScript = await new PushDrop(wallet).lock(
      [
        Utils.toArray(slip.prefix, 'base64'),
        Utils.toArray(slip.suffix, 'base64'),
        [1],
        Utils.toArray(slip.memo, 'utf8')
      ],
      SLIP_PROTOCOL,
      slip.tokenKey,
      'self'
    )

    const { signableTransaction } = await wallet.createAction({
      description: 'mark deposit slip as used',
      inputBEEF: slip.tokenBEEF,
      inputs: [{
        outpoint: `${slip.tokenTxid}.${slip.tokenOutputIndex}`,
        unlockingScriptLength: 74,
        inputDescription: 'Consume old deposit slip'
      }],
      outputs: [{
        outputDescription: 'Deposit slip',
        satoshis: 1,
        lockingScript: newSlipScript.toHex(),
        basket: 'deposit slips',
        customInstructions: JSON.stringify({ tokenKey: slip.tokenKey })
      }],
      options: { acceptDelayedBroadcast: false, randomizeOutputs: false }
    })

    const unlocker = new PushDrop(wallet).unlock(SLIP_PROTOCOL, slip.tokenKey, 'self')
    await wallet.signAction({
      reference: signableTransaction?.reference as string,
      spends: {
        0: {
          unlockingScript: (
            await unlocker.sign(
              Transaction.fromAtomicBEEF(signableTransaction?.tx as number[]),
              0
            )
          ).toHex()
        }
      }
    })
  }

  const depositAtomicBEEFs = async () => {
    const rawInput = incomingBEEFs.trim()
    if (!rawInput) return

    setIsDepositing(true)
    setError(null)

    const candidates = rawInput.split(/\s+/).map(v => v.trim()).filter(Boolean)
    if (!candidates.length) {
      setIsDepositing(false)
      return
    }

    const slipMap = new Map<string, { slip: Slip, index: number }>()
    depositSlips.forEach((slip, index) => {
      slipMap.set(slip.hashHex, { slip, index })
    })

    const plans: Array<{
      raw: string
      atomic: number[]
      matches: Array<{ slip: Slip, index: number, outputIndex: number }>
    }> = []
    const parseFailures: string[] = []
    const unmatched: string[] = []

    for (const raw of candidates) {
      try {
        const atomic = Utils.toArray(raw, 'hex') as number[]
        const tx = Transaction.fromAtomicBEEF(atomic)
        const matches: Array<{ slip: Slip, index: number, outputIndex: number }> = []

        tx.outputs.forEach((output, outputIndex) => {
          if (output.lockingScript.chunks.length < 5) return
          const pkh = output.lockingScript.chunks[2]?.data as number[] | undefined
          if (!Array.isArray(pkh) || pkh.length !== 20) return
          const hashHex = Utils.toHex(pkh)
          const match = slipMap.get(hashHex)
          if (!match) return
          matches.push({ slip: match.slip, index: match.index, outputIndex })
        })

        if (!matches.length) {
          unmatched.push(raw)
          continue
        }

        plans.push({ raw, atomic, matches })
      } catch {
        parseFailures.push(raw)
      }
    }

    if (!plans.length) {
      const notices: string[] = []
      if (parseFailures.length) {
        notices.push(`${parseFailures.length} Atomic BEEF value${parseFailures.length > 1 ? 's' : ''} could not be parsed.`)
      }
      if (unmatched.length) {
        notices.push(`${unmatched.length} Atomic BEEF value${unmatched.length > 1 ? 's' : ''} did not match any deposit slip.`)
      }
      if (!notices.length) {
        notices.push('No deposit slips matched the provided Atomic BEEF.')
      }
      setError(notices.join(' '))
      setIsDepositing(false)
      return
    }

    const usedWarnings = new Set<string>()
    plans.forEach(plan => {
      plan.matches.forEach(({ slip }) => {
        if (slip.used) usedWarnings.add(slip.address)
      })
    })

    if (usedWarnings.size) {
      const proceed = window.confirm(
        [
          'Some deposit slips are already marked USED:',
          ...Array.from(usedWarnings).map(addr => `• ${addr}`),
          'Continue with the deposit?'
        ].join('\n')
      )
      if (!proceed) {
        setIsDepositing(false)
        return
      }
    }

    const markIndices = new Set<number>()
    try {
      for (const plan of plans) {
        await wallet.internalizeAction({
          tx: plan.atomic,
          description: 'Deposit funds from deposit slip',
          outputs: plan.matches.map(({ slip, outputIndex }) => ({
            outputIndex,
            protocol: 'wallet payment',
            paymentRemittance: {
              derivationPrefix: slip.prefix,
              derivationSuffix: slip.suffix,
              senderIdentityKey: anyone.keyDeriver?.identityKey as string
            }
          }))
        })

        plan.matches.forEach(({ slip, index }) => {
          if (!slip.used) markIndices.add(index)
        })
      }
    } catch (e: any) {
      setError(e?.message || 'Failed to deposit Atomic BEEF.')
      setIsDepositing(false)
      return
    }

    const updatedSlips = [...depositSlips]
    const markErrors: string[] = []

    for (const index of markIndices) {
      const slip = updatedSlips[index]
      if (!slip) continue
      try {
        await markSlipAsUsed(slip)
        updatedSlips[index] = { ...slip, used: true }
      } catch (e: any) {
        markErrors.push(e?.message || `Failed to mark slip ${slip.address} as used.`)
      }
    }

    setDepositSlips(updatedSlips)
    setIncomingBEEFs('')

    const warnings: string[] = []
    if (parseFailures.length) {
      warnings.push(`${parseFailures.length} Atomic BEEF value${parseFailures.length > 1 ? 's' : ''} could not be parsed.`)
    }
    if (unmatched.length) {
      warnings.push(`${unmatched.length} Atomic BEEF value${unmatched.length > 1 ? 's' : ''} did not match any deposit slip.`)
    }
    if (markErrors.length) {
      warnings.push(...markErrors)
    }

    setError(warnings.length ? warnings.join(' ') : null)
    setIsDepositing(false)
  }

  // Outgoing funding (unchanged logic)
  const handleSend = async () => {
    setIsSending(true)
    setError(null)
    try {
      const { tx } = await wallet.createAction({
        description: 'Fund',
        outputs: [{
          outputDescription: 'Fund',
          lockingScript: new P2PKH().lock(sendToAddress).toHex(),
          satoshis: Number(sendAmount)
        }]
      })
      setSentAtomicBEEF(Utils.toHex(tx as number[]))
    } catch (e: any) {
      setError(e?.message || 'Failed to create action.')
    } finally {
      setIsSending(false)
    }
  }

  // Utils
  const copy = async (what: 'atom' | 'addr' | `slip-${number}`) => {
    let text = ''
    if (what === 'atom') text = sentAtomicBEEF
    else if (what === 'addr') text = sendToAddress
    else {
      const idx = Number(what.split('-')[1])
      text = depositSlips[idx]?.address || ''
    }

    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(what)
      setTimeout(() => setCopied(null), 1200)
    } catch { /* noop */ }
  }

  const downloadSlipTxt = (slip: Slip) => {
    // Metanet Client–style deposit slip text and instructions (NOT the vault format)
    const now = new Date().toISOString()
    const txt = [
      'BSV Deposit Slip (Metanet Client)',
      '------------------------',
      `Memo:          ${slip.memo || '(none)'}`,
      `Used:          ${slip.used ? 'Yes' : 'No'}`,
      '',
      `Public key:    (derived via counterparty=anyone from prefix/suffix)`,
      `Pubkey hash:   (embedded in Address)`,
      `P2PKH Script:  (standard pay-to-pubkey-hash for Address)`,
      `Address:       ${slip.address}`,
      '',
      `Derivation Prefix (base64): ${slip.prefix}`,
      `Derivation Suffix (base64): ${slip.suffix}`,
      '',
      `Created/Exported At: ${now}`,
      '',
      'Instructions:',
      '- Use the Funder app to create an Atomic BEEF that PAYS THIS ADDRESS.',
      '- Paste that Atomic BEEF below in the Metanet Client to deposit to this slip.',
      '- Once deposited, this slip will be marked as USED. Do not reuse slips.',
      slip.used
        ? '- WARNING: This slip is already used. Reusing harms privacy and is discouraged.'
        : '',
      ''
    ].join('\n')

    const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `deposit-slip_${slip.address}${slip.used ? '_USED' : ''}.txt`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const sortedSlips = useMemo(() => {
    const fresh = depositSlips.filter(s => !s.used)
    const used = depositSlips.filter(s => s.used)
    return [...fresh, ...used]
  }, [depositSlips])

  const canSend = !!sendToAddress && !!sendAmount && !isSending

  return (
    <div className="app-root">
      <div className="card">
        <h1 className="title">Funder</h1>

        {/* Tabs */}
        <div className="tabs" role="tablist" aria-label="Wallet actions">
          <button
            role="tab"
            aria-selected={tab === 'outgoing'}
            className={`tab ${tab === 'outgoing' ? 'active' : ''}`}
            onClick={() => setTab('outgoing')}
          >
            Outgoing
          </button>
          <button
            role="tab"
            aria-selected={tab === 'incoming'}
            className={`tab ${tab === 'incoming' ? 'active' : ''}`}
            onClick={() => setTab('incoming')}
          >
            Incoming
          </button>
        </div>

        {/* OUTGOING TAB */}
        {tab === 'outgoing' && (
          <>
            <label className="label">
              Address
              <div className="row">
                <input
                  className="input wide"
                  placeholder="Enter an address..."
                  type="text"
                  value={sendToAddress}
                  onChange={(e) => setSendToAddress(e.target.value)}
                />
                <button
                  className="ghost"
                  onClick={() => copy('addr')}
                  title="Copy address"
                  disabled={!sendToAddress}
                >
                  {copied === 'addr' ? '✓ Copied' : 'Copy'}
                </button>
              </div>
            </label>

            <label className="label">
              Amount (satoshis)
              <input
                className="input"
                placeholder="Amount (satoshis)"
                type="number"
                value={sendAmount}
                onChange={(e) => setSendAmount(e.target.value)}
                min={0}
              />
            </label>

            <button
              className={`primary ${!canSend ? 'disabled' : ''}`}
              onClick={handleSend}
              disabled={!canSend}
            >
              {isSending ? (
                <span className="spinner-wrap">
                  <span className="spinner" /> Sending…
                </span>
              ) : (
                'Send'
              )}
            </button>

            {error && <p className="error">{error}</p>}

            <div className="output">
              <div className="output-head">
                <span>Atomic BEEF</span>
                <button
                  className="ghost"
                  onClick={() => copy('atom')}
                  disabled={!sentAtomicBEEF}
                  title="Copy Atomic BEEF"
                >
                  {copied === 'atom' ? '✓ Copied' : 'Copy'}
                </button>
              </div>
              <pre className="atom-box">
                {sentAtomicBEEF || '— nothing yet —'}
              </pre>
            </div>
          </>
        )}

        {/* INCOMING TAB */}
        {tab === 'incoming' && (
          <>
            <div className="section-head">
              <div className="left">
                <div className="subtitle">Deposit Slips</div>
                <div className="muted">Unused slips appear first. Reuse is discouraged.</div>
              </div>
              <div className="right new-slip">
                <input
                  className="input memo"
                  placeholder="Memo (optional)"
                  value={newSlipMemo}
                  onChange={(e) => setNewSlipMemo(e.target.value)}
                />
                <button className="primary" onClick={() => createDepositSlip(newSlipMemo)}>
                  New Slip
                </button>
              </div>
            </div>

            <label className="label">
              Atomic BEEF deposits
              <textarea
                className="textarea"
                placeholder="Paste one or more hex-encoded Atomic BEEFs. Separate multiple values with spaces or new lines."
                value={incomingBEEFs}
                onChange={(e) => setIncomingBEEFs(e.target.value)}
              />
            </label>
            <div className="actions-row">
              <button
                className={`primary ${!incomingBEEFs.trim() || isDepositing ? 'disabled' : ''}`}
                disabled={!incomingBEEFs.trim() || isDepositing}
                onClick={depositAtomicBEEFs}
              >
                {isDepositing ? (
                  <span className="spinner-wrap"><span className="spinner" /> Depositing…</span>
                ) : (
                  'Deposit to Wallet'
                )}
              </button>
              <button
                className="ghost"
                onClick={() => setIncomingBEEFs('')}
                disabled={!incomingBEEFs || isDepositing}
              >
                Clear
              </button>
              <span className="muted">We’ll match each output to its slip automatically.</span>
            </div>

            <div className="slip-list">
              {sortedSlips.length === 0 && (
                <div className="empty">No deposit slips yet. Create one above.</div>
              )}

              {sortedSlips.map((slip) => {
                // Map back to actual index in depositSlips for actions/state
                const realIndex = depositSlips.findIndex(s =>
                  s.prefix === slip.prefix &&
                  s.suffix === slip.suffix &&
                  s.tokenTxid === slip.tokenTxid &&
                  s.tokenOutputIndex === slip.tokenOutputIndex
                )

                const warnReuse = slip.used

                return (
                  <div className={`slip ${warnReuse ? 'used' : ''}`} key={`${slip.tokenTxid}.${slip.tokenOutputIndex}`}>
                    <div className="slip-row">
                      <div className="slip-meta">
                        <div className="slip-topline">
                          <span className="badge">{warnReuse ? 'USED' : 'NEW'}</span>
                          <span className="addr">{slip.address}</span>
                        </div>
                        <div className="meta-line">
                          <span className="tag">prefix</span>
                          <span className="mono small">{slip.prefix}</span>
                          <span className="sep">·</span>
                          <span className="tag">suffix</span>
                          <span className="mono small">{slip.suffix}</span>
                          {slip.memo ? (
                            <>
                              <span className="sep">·</span>
                              <span className="tag">memo</span>
                              <span className="mono small">{slip.memo}</span>
                            </>
                          ) : null}
                        </div>
                      </div>

                      <div className="slip-actions">
                        <button
                          className="ghost"
                          onClick={() => copy(`slip-${realIndex}`)}
                          disabled={!slip.address}
                          title="Copy address"
                        >
                          {copied === `slip-${realIndex}` ? '✓ Copied' : 'Copy Address'}
                        </button>
                        <button
                          className="ghost"
                          onClick={() => {
                            if (slip.used) {
                              const ok = window.confirm(
                                'This slip is already used. Reusing harms privacy. Continue to download anyway?'
                              )
                              if (!ok) return
                            }
                            downloadSlipTxt(slip)
                          }}
                          title="Download deposit slip (.txt)"
                        >
                          Download
                        </button>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>

            {error && <p className="error">{error}</p>}
          </>
        )}

        {/* Instructions Panel */}
<details className="guide" open>
  <summary className="guide-summary">
    <span className="guide-title">How this works</span>
    <span className="guide-toggle">Show/Hide</span>
  </summary>

  <div className="guide-body">
    <div className="callout success">
      <strong>Goal:</strong> Move funds between “Metanet Client” (MNC) and anyone—without chain scanning—using <em>Atomic BEEF</em>.
    </div>

    {tab === 'incoming' ? (
      <>
        <div className="steps">
          <h4>Receiving funds (Incoming tab)</h4>
          <ol>
            <li><strong>Create a deposit slip.</strong> Each slip derives a fresh address (counterparty=<code>anyone</code>).</li>
            <li><strong>Share the slip’s address.</strong> The sender can fund it from any tool that outputs Atomic BEEF.</li>
            <li><strong>Collect Atomic BEEF.</strong> Paste one or more hex strings into the deposit area above—whitespace separation is fine.</li>
            <li><strong>Deposit to wallet.</strong> The app matches every paying output to its slip automatically and marks unused slips as <strong>USED</strong>.</li>
            <li><strong>Privacy note:</strong> You’ll be warned before depositing to a slip that’s already marked used. Prefer a fresh slip per payment.</li>
          </ol>
        </div>

        <div className="callout info">
          <strong>What if the sender’s wallet doesn’t give Atomic BEEF?</strong><br />
          Best practice is for wallets to include Atomic BEEF when they pay you. If they can’t, you may fall back to a chain-scanning service, but it <strong>reduces privacy</strong> and adds third-party reliance.
        </div>

        <div className="steps">
          <h4>Exporting a deposit slip</h4>
          <ul>
            <li>Use <em>Download</em> to save a <code>.txt</code> file with the address and setup details.</li>
            <li>Exporting an already <strong>USED</strong> slip is allowed but discouraged for new funding rounds.</li>
          </ul>
        </div>

        <div className="callout warn">
          <strong>Warnings</strong>
          <ul>
            <li>Reusing deposit slips harms privacy and may link activity.</li>
            <li>Only deposit Atomic BEEF that actually pays the slip’s address—otherwise it will be rejected.</li>
            <li>Keep exported files safe; they contain derivation hints.</li>
          </ul>
        </div>
      </>
    ) : (
      <>
        <div className="steps">
          <h4>Sending funds (Outgoing tab)</h4>
          <ol>
            <li><strong>Enter the recipient’s address</strong> and amount in satoshis.</li>
            <li><strong>Click Send</strong> to build the transaction and copy the generated Atomic BEEF.</li>
            <li><strong>Share the Atomic BEEF</strong> with the recipient so they can internalize it without chain scanning.</li>
          </ol>
        </div>

        <div className="callout info">
          <strong>Tip:</strong> Any outputs you include can land on multiple slips. Encourage recipients to keep slips fresh for privacy.
        </div>

        <div className="callout warn">
          <strong>Reminder:</strong> Atomic BEEF is the signed transaction. Only hand it to the intended recipient.
        </div>
      </>
    )}
  </div>
</details>

      </div>
    </div>
  )
}

export default App
