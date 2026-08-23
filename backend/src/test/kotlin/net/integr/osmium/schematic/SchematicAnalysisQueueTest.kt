package net.integr.osmium.schematic

import net.integr.osmium.TestcontainersConfiguration
import net.integr.osmium.liveupdates.LiveUpdateBroker
import net.integr.osmium.schematic.config.SchematicProperties
import net.integr.osmium.schematic.repository.SchematicRepository
import net.integr.osmium.schematic.service.SchematicAnalyser
import net.integr.osmium.schematic.service.SchematicAnalysisQueue
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.ObjectProvider
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.context.annotation.Import
import java.util.concurrent.CountDownLatch
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit

/**
 * Reading the line while the worker is draining it.
 *
 * This is a race, so the test is a bounded hammer rather than a single deterministic case. It earns
 * its place because the bug it pins was silent, intermittent, and reached the operator as a **404
 * on the first upload after a restart** — with the bytes already written.
 */
@SpringBootTest(
    properties = [
        // **Never the real storage directory.** Every Spring context here boots
        // SchematicReconciler, which sweeps files whose row it cannot find - and the row is in an
        // empty Testcontainers database, so every file looks like an orphan. Pointed at
        // `data/schematics`, running the suite silently deletes whatever a developer has uploaded
        // locally.
        "osmium.schematic.directory=\${java.io.tmpdir}/osmium-schematic-test",
    ],
)
@Import(TestcontainersConfiguration::class)
class SchematicAnalysisQueueTest {

    @Autowired private lateinit var repository: SchematicRepository
    @Autowired private lateinit var properties: SchematicProperties
    @Autowired private lateinit var broker: LiveUpdateBroker
    @Autowired private lateinit var analyser: SchematicAnalyser

    /**
     * Enough to hit the race many times over without turning a unit test into a minute of database
     * round trips: each enqueue announces, and announcing reads. The reader is cheap, so it runs far
     * more often than the writer.
     */
    private val enqueues = 1_500
    private val reads = 40_000

    /**
     * `toList()` on a queue of exactly one reads `size`, sees 1, then calls `iterator().next()`.
     * The worker taking that element in between leaves nothing to return and it throws
     * `NoSuchElementException` — which escaped an `afterCommit` and was mapped to 404.
     *
     * A queue of one is therefore the case to hammer, not a long one.
     */
    @Test
    fun `describing the line never trips over the worker draining it`() {
        val failures = CopyOnWriteArrayList<Throwable>()
        val started = CountDownLatch(1)

        val queue = SchematicAnalysisQueue(
            analyser = object : ObjectProvider<SchematicAnalyser> {
                override fun getObject(): SchematicAnalyser {
                    started.countDown()
                    // Nothing to read: every id here is invented, so `analyse` returns at once and
                    // the worker comes straight back for the next one. That is what keeps the queue
                    // hovering around a single element, which is the case that broke.
                    return analyser
                }
            },
            repository = repository,
            properties = properties,
            broker = broker,
        )

        val reader = Thread {
            repeat(reads) {
                runCatching { queue.positions() }.onFailure(failures::add)
            }
        }

        try {
            reader.start()
            // Ids nothing owns: the announcement finds no rows and publishes nothing, so this
            // measures the snapshot and not the database.
            repeat(enqueues) { queue.enqueue(900_000L + it) }
            reader.join(30_000)

            assertTrue(started.await(10, TimeUnit.SECONDS), "the worker never ran")
            assertTrue(failures.isEmpty(), "reading the line threw: ${failures.firstOrNull()}")
        } finally {
            queue.stop()
        }
    }
}
