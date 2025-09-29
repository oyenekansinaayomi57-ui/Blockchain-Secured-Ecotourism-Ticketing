(define-constant CONTRACT_OWNER tx-sender)
(define-constant ERR_NOT_AUTHORIZED u100)
(define-constant ERR_INVALID_ORG u101)
(define-constant ERR_INSUFFICIENT_FUNDS u102)
(define-constant ERR_TICKET_EXISTS u103)
(define-constant ERR_INVALID_EVENT u104)
(define-constant ERR_INVALID_AMOUNT u105)
(define-constant ERR_TICKET_NOT_FOUND u106)
(define-constant ERR_ALREADY_REDEEMED u107)
(define-constant ERR_INVALID_TIMESTAMP u108)
(define-constant ERR_ESCROW_NOT_SET u109)
(define-constant ERR_INVALID_FEE u110)
(define-constant ERR_INVALID_DISCOUNT u111)
(define-constant ERR_NOT_ORGANIZER u112)

(define-data-var ticket-counter uint u0)
(define-data-var platform-fee uint u1000)
(define-data-var escrow-contract (optional principal) none)
(define-data-var discount-rate uint u10)
(define-data-var max-tickets-per-event uint u1000)

(define-map Tickets
  { ticket-id: uint }
  { buyer: principal, org-id: uint, event-id: (string-utf8 32), price: uint, timestamp: uint, redeemed: bool, discount-applied: bool })

(define-map EventDetails
  { event-id: (string-utf8 32) }
  { organizer: principal, ticket-price: uint, total-tickets: uint, available-tickets: uint, active: bool })

(define-read-only (get-ticket (ticket-id uint))
  (map-get? Tickets { ticket-id: ticket-id }))

(define-read-only (get-event-details (event-id (string-utf8 32)))
  (map-get? EventDetails { event-id: event-id }))

(define-read-only (get-platform-fee)
  (ok (var-get platform-fee)))

(define-read-only (get-discount-rate)
  (ok (var-get discount-rate)))

(define-read-only (get-ticket-count)
  (ok (var-get ticket-counter)))

(define-private (validate-event-id (event-id (string-utf8 32)))
  (if (and (> (len event-id) u0) (<= (len event-id) u32))
      (ok true)
      (err ERR_INVALID_EVENT)))

(define-private (validate-amount (amount uint))
  (if (> amount u0)
      (ok true)
      (err ERR_INVALID_AMOUNT)))

(define-private (validate-timestamp (ts uint))
  (if (>= ts block-height)
      (ok true)
      (err ERR_INVALID_TIMESTAMP)))

(define-private (validate-fee (fee uint))
  (if (>= fee u0)
      (ok true)
      (err ERR_INVALID_FEE)))

(define-private (validate-discount (discount uint))
  (if (<= discount u100)
      (ok true)
      (err ERR_INVALID_DISCOUNT)))

(define-public (set-escrow-contract (contract-principal principal))
  (begin
    (asserts! (is-eq tx-sender CONTRACT_OWNER) (err ERR_NOT_AUTHORIZED))
    (var-set escrow-contract (some contract-principal))
    (ok true)))

(define-public (set-platform-fee (new-fee uint))
  (begin
    (asserts! (is-eq tx-sender CONTRACT_OWNER) (err ERR_NOT_AUTHORIZED))
    (try! (validate-fee new-fee))
    (var-set platform-fee new-fee)
    (ok true)))

(define-public (set-discount-rate (new-rate uint))
  (begin
    (asserts! (is-eq tx-sender CONTRACT_OWNER) (err ERR_NOT_AUTHORIZED))
    (try! (validate-discount new-rate))
    (var-set discount-rate new-rate)
    (ok true)))

(define-public (create-event (event-id (string-utf8 32)) (ticket-price uint) (total-tickets uint))
  (begin
    (try! (validate-event-id event-id))
    (try! (validate-amount ticket-price))
    (asserts! (> total-tickets u0) (err ERR_INVALID_AMOUNT))
    (asserts! (<= total-tickets (var-get max-tickets-per-event)) (err ERR_INVALID_AMOUNT))
    (asserts! (is-none (map-get? EventDetails { event-id: event-id })) (err ERR_TICKET_EXISTS))
    (map-set EventDetails { event-id: event-id }
      { organizer: tx-sender, ticket-price: ticket-price, total-tickets: total-tickets, available-tickets: total-tickets, active: true })
    (ok true)))

(define-public (buy-ticket (org-id uint) (event-id (string-utf8 32)) (apply-discount bool))
  (let ((ticket-id (var-get ticket-counter))
        (event (unwrap! (map-get? EventDetails { event-id: event-id }) (err ERR_INVALID_EVENT)))
        (ticket-price (get ticket-price event))
        (fee (var-get platform-fee))
        (discount (if apply-discount (var-get discount-rate) u0))
        (discounted-price (/ (* ticket-price (- u100 discount)) u100))
        (total-price (+ discounted-price fee))
        (escrow (unwrap! (var-get escrow-contract) (err ERR_ESCROW_NOT_SET))))
    (try! (contract-call? .org-registry is-valid-org org-id))
    (asserts! (get active event) (err ERR_INVALID_EVENT))
    (asserts! (> (get available-tickets event) u0) (err ERR_INVALID_AMOUNT))
    (try! (validate-amount ticket-price))
    (try! (validate-timestamp block-height))
    (asserts! (>= (stx-get-balance tx-sender) total-price) (err ERR_INSUFFICIENT_FUNDS))
    (try! (stx-transfer? discounted-price tx-sender escrow))
    (try! (stx-transfer? fee tx-sender CONTRACT_OWNER))
    (try! (contract-call? .ticket-nft mint-ticket ticket-id tx-sender event-id))
    (map-set Tickets { ticket-id: ticket-id }
      { buyer: tx-sender, org-id: org-id, event-id: event-id, price: discounted-price, timestamp: block-height, redeemed: false, discount-applied: apply-discount })
    (map-set EventDetails { event-id: event-id }
      (merge event { available-tickets: (- (get available-tickets event) u1) }))
    (var-set ticket-counter (+ ticket-id u1))
    (print { event: "ticket-purchased", ticket-id: ticket-id, event-id: event-id })
    (ok ticket-id)))

(define-public (redeem-ticket (ticket-id uint))
  (let ((ticket (unwrap! (map-get? Tickets { ticket-id: ticket-id }) (err ERR_TICKET_NOT_FOUND)))
        (event (unwrap! (map-get? EventDetails { event-id: (get event-id ticket) }) (err ERR_INVALID_EVENT))))
    (asserts! (is-eq tx-sender (get organizer event)) (err ERR_NOT_AUTHORIZED))
    (asserts! (not (get redeemed ticket)) (err ERR_ALREADY_REDEEMED))
    (map-set Tickets { ticket-id: ticket-id }
      (merge ticket { redeemed: true }))
    (print { event: "ticket-redeemed", ticket-id: ticket-id })
    (ok true)))