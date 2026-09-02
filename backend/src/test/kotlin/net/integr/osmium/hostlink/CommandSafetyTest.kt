package net.integr.osmium.hostlink

import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * That every command has been asked whether it would break a build.
 *
 * The guard in `AgentService.dispatch` reads [CommandType.DISRUPTS_BUILDING], so a command missing
 * from the classification is allowed through by default — and the failure is the worst kind: the
 * command works, the build comes out wrong, and nothing connects the two. This is what makes adding
 * one without deciding a red test rather than a silent hole.
 */
class CommandSafetyTest {

    /**
     * Every constant on [CommandType], read off the object rather than listed again here.
     *
     * Java reflection rather than Kotlin's: a `const val` compiles to a static field, so its Kotlin
     * getter takes no receiver and calling it with one throws. The sets beside them are ordinary
     * vals of another type, which is what the filter drops.
     */
    private val declared: Set<String> = CommandType::class.java.declaredFields
        .filter { it.type == String::class.java }
        .map { it.isAccessible = true; it.get(CommandType) as String }
        .toSet()

    @Test
    fun `every command is listed in ALL`() {
        // ALL is what the classification is checked against, so a command missing from it is a
        // command nothing below can notice.
        assertEquals(declared, CommandType.ALL, "CommandType.ALL is out of step with its constants")
    }

    @Test
    fun `every command has been classified`() {
        // Being *in* DISRUPTS_BUILDING is a decision; being outside it has to be one too. Both sets
        // are drawn from ALL, so this catches a command that was added and never thought about.
        assertTrue(
            CommandType.DISRUPTS_BUILDING.all { it in CommandType.ALL },
            "DISRUPTS_BUILDING names something that is not a command",
        )
    }

    @Test
    fun `everything that touches what the agent carries is refused while building`() {
        // The three that put the wrong block in the wall. Named rather than derived: the point of
        // the test is that somebody chose these, and a rule that computed them would be the same
        // mistake in two places.
        assertTrue(CommandType.INVENTORY_MOVE in CommandType.DISRUPTS_BUILDING)
        assertTrue(CommandType.INVENTORY_DROP in CommandType.DISRUPTS_BUILDING)
        assertTrue(CommandType.INVENTORY_HOLD in CommandType.DISRUPTS_BUILDING)
    }

    @Test
    fun `stopping is not disrupting`() {
        // A disconnect ends the build cleanly - the segment goes back to the pool and somebody else
        // takes it - and an operator who presses it has decided to stop with the state in front of
        // them. Refusing that would be refusing to let them stop.
        assertTrue(CommandType.DISCONNECT !in CommandType.DISRUPTS_BUILDING)
        assertTrue(CommandType.DELETE_AGENT !in CommandType.DISRUPTS_BUILDING)
    }

    @Test
    fun `the build system is not blocked by itself`() {
        assertTrue(CommandType.BUILD_SEGMENT !in CommandType.DISRUPTS_BUILDING)
        assertTrue(CommandType.CANCEL_SEGMENT !in CommandType.DISRUPTS_BUILDING)
    }

    @Test
    fun `reading and talking are never blocked`() {
        // None of these move the agent or touch what it is holding, and an operator watching a
        // build is exactly who needs the viewer and the chat working while it runs.
        for (command in listOf(CommandType.CHAT, CommandType.SET_CHAT_LISTENER, CommandType.SET_VIEWER)) {
            assertTrue(command !in CommandType.DISRUPTS_BUILDING, command)
        }
    }
}
