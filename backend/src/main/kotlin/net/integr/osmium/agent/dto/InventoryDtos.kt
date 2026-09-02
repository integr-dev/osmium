package net.integr.osmium.agent.dto

import io.swagger.v3.oas.annotations.media.Schema
import jakarta.validation.constraints.Max
import jakarta.validation.constraints.Min

/**
 * Slot numbers here are **Minecraft's own**, in the player window: 5-8 armour, 9-35 the backpack,
 * 36-44 the hotbar, 45 the off hand.
 *
 * Relayed rather than renumbered. A move is carried out as a click on a slot, so any renumbering
 * between the screen and the click is somewhere the two can disagree about which square somebody
 * pointed at, and the host would have to undo it again to act on it.
 *
 * The 2x2 crafting grid (1-4) and its output square (0) are outside the accepted range on purpose:
 * they hold items only while a recipe is half-assembled, and the output is not a container at all.
 */
private const val FIRST_MOVABLE = 5L
private const val LAST_MOVABLE = 45L

/** The nine squares an agent can hold, which is the only range a hand change accepts. */
private const val FIRST_HOTBAR = 36L
private const val LAST_HOTBAR = 44L

@Schema(
    description = "One occupied square of an agent's inventory. Empty squares are absent rather " +
        "than null, which is what a client draws anyway.",
)
data class InventorySlotResponse(
    @field:Schema(
        description = "Minecraft's own slot number in the player window: 5-8 armour, 9-35 the " +
            "backpack, 36-44 the hotbar, 45 the off hand.",
        example = "36",
    )
    val slot: Int,
    @field:Schema(description = "The item id, for looking up an icon.", example = "diamond_pickaxe")
    val name: String,
    @field:Schema(description = "What the game calls it.", example = "Diamond Pickaxe")
    val displayName: String,
    @field:Schema(example = "1")
    val count: Int,
    @field:Schema(
        description = "How much of the item's life is used up. Null for anything that does not " +
            "wear out, which is not the same as an undamaged tool.",
        example = "142",
    )
    val damage: Int?,
    @field:Schema(description = "What `damage` is out of. Present exactly when `damage` is.", example = "1561")
    val maxDamage: Int?,
)

@Schema(
    description = "What an agent is carrying. Never stored - an agent that has not reported " +
        "recently has none, rather than showing an hour-old inventory as though it were now.",
)
data class AgentInventoryResponse(
    @field:Schema(description = "Occupied squares only.")
    val slots: List<InventorySlotResponse>,
    @field:Schema(description = "Which hotbar square is in hand, 0 to 8.", example = "0")
    val held: Int,
)

@Schema(
    description = "Moves what is in one square onto another, as two clicks would. Fire and " +
        "forget: where the item ended up arrives on the next inventory report.",
)
data class MoveItemRequest(
    @field:Min(FIRST_MOVABLE)
    @field:Max(LAST_MOVABLE)
    val from: Int,
    @field:Min(FIRST_MOVABLE)
    @field:Max(LAST_MOVABLE)
    val to: Int,
)

@Schema(
    description = "Puts a hotbar square in the agent's hand. The square, 36-44, not the 0-8 index " +
        "the game keeps: every request here names a square the same way, and the one index in this " +
        "API is `held`, which is a field the game itself defines as one.",
)
data class HoldItemRequest(
    @field:Min(FIRST_HOTBAR)
    @field:Max(LAST_HOTBAR)
    val slot: Int,
)

@Schema(description = "Throws what is in a square on the ground.")
data class DropItemRequest(
    @field:Min(FIRST_MOVABLE)
    @field:Max(LAST_MOVABLE)
    val slot: Int,
    @field:Min(1)
    @field:Schema(description = "How many to throw. Null throws the whole stack.", example = "16")
    val count: Int? = null,
)
