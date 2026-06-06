; Deliveroo JS — crates (Sokoban-style) domain
; Cells are objects c_x_y. The agent walks on free cells and can PUSH a crate
; one cell in the direction of motion if the cell beyond is free.
(define (domain deliveroo-crates)

    (:requirements :strips :negative-preconditions)

    (:predicates
        (at ?c)                     ; our agent is at cell c
        (crate ?c)                  ; a crate occupies cell c
        (is-blocked ?c)             ; cell c is a wall / non-walkable
        (crate-spawn ?c)            ; cell c is a yellow crate cell — only cells a crate may slide onto
        (neighbourUp ?c1 ?c2)       ; c2 is above c1
        (neighbourDown ?c1 ?c2)     ; c2 is below c1
        (neighbourLeft ?c1 ?c2)     ; c2 is left of c1
        (neighbourRight ?c1 ?c2)    ; c2 is right of c1
    )

    ;; --- Move into a free neighbouring cell ---

    (:action move-up
        :parameters (?c1 ?c2)
        :precondition (and (at ?c1) (neighbourUp ?c1 ?c2)
                           (not (is-blocked ?c2)) (not (crate ?c2)))
        :effect (and (at ?c2) (not (at ?c1)))
    )
    (:action move-down
        :parameters (?c1 ?c2)
        :precondition (and (at ?c1) (neighbourDown ?c1 ?c2)
                           (not (is-blocked ?c2)) (not (crate ?c2)))
        :effect (and (at ?c2) (not (at ?c1)))
    )
    (:action move-left
        :parameters (?c1 ?c2)
        :precondition (and (at ?c1) (neighbourLeft ?c1 ?c2)
                           (not (is-blocked ?c2)) (not (crate ?c2)))
        :effect (and (at ?c2) (not (at ?c1)))
    )
    (:action move-right
        :parameters (?c1 ?c2)
        :precondition (and (at ?c1) (neighbourRight ?c1 ?c2)
                           (not (is-blocked ?c2)) (not (crate ?c2)))
        :effect (and (at ?c2) (not (at ?c1)))
    )

    ;; --- Push a crate one cell: agent c1 -> c2 (crate), crate c2 -> c3 ---

    (:action push-up
        :parameters (?c1 ?c2 ?c3)
        :precondition (and (at ?c1) (neighbourUp ?c1 ?c2) (neighbourUp ?c2 ?c3)
                           (crate ?c2) (not (crate ?c3)) (not (is-blocked ?c3))
                           (crate-spawn ?c3))
        :effect (and (at ?c2) (not (at ?c1)) (crate ?c3) (not (crate ?c2)))
    )
    (:action push-down
        :parameters (?c1 ?c2 ?c3)
        :precondition (and (at ?c1) (neighbourDown ?c1 ?c2) (neighbourDown ?c2 ?c3)
                           (crate ?c2) (not (crate ?c3)) (not (is-blocked ?c3))
                           (crate-spawn ?c3))
        :effect (and (at ?c2) (not (at ?c1)) (crate ?c3) (not (crate ?c2)))
    )
    (:action push-left
        :parameters (?c1 ?c2 ?c3)
        :precondition (and (at ?c1) (neighbourLeft ?c1 ?c2) (neighbourLeft ?c2 ?c3)
                           (crate ?c2) (not (crate ?c3)) (not (is-blocked ?c3))
                           (crate-spawn ?c3))
        :effect (and (at ?c2) (not (at ?c1)) (crate ?c3) (not (crate ?c2)))
    )
    (:action push-right
        :parameters (?c1 ?c2 ?c3)
        :precondition (and (at ?c1) (neighbourRight ?c1 ?c2) (neighbourRight ?c2 ?c3)
                           (crate ?c2) (not (crate ?c3)) (not (is-blocked ?c3))
                           (crate-spawn ?c3))
        :effect (and (at ?c2) (not (at ?c1)) (crate ?c3) (not (crate ?c2)))
    )
)
