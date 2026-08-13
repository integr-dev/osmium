package net.integr.osmium.account.service

import org.junit.jupiter.api.Test
import kotlin.test.assertEquals

/**
 * These end up on screen, so they are written the way a person would write them. Java hands back
 * IPv6 in full — loopback arrives as `0:0:0:0:0:0:0:1`, which takes three columns to say `::1`.
 */
class ClientDetailsTest {

    @Test
    fun `an IPv4 address is left alone`() {
        assertEquals("203.0.113.7", ClientDetails.normalise("203.0.113.7"))
    }

    @Test
    fun `loopback is written the short way`() {
        assertEquals("::1", ClientDetails.normalise("0:0:0:0:0:0:0:1"))
    }

    @Test
    fun `the longest run of zeroes collapses`() {
        assertEquals("2001:db8::1", ClientDetails.normalise("2001:0db8:0000:0000:0000:0000:0000:0001"))
    }

    /** Two `::` in one address cannot be read back, so only the longest run goes. */
    @Test
    fun `only one run collapses, and it is the longest`() {
        // Three zeroes, then two. The shorter run stays written out.
        assertEquals("2001::1:0:0:1", ClientDetails.normalise("2001:0:0:0:1:0:0:1"))
    }

    /** `::` for one group saves nothing and RFC 5952 forbids it. */
    @Test
    fun `a lone zero group is written out`() {
        assertEquals("2001:db8:0:1:1:1:1:1", ClientDetails.normalise("2001:db8:0:1:1:1:1:1"))
    }

    /** An IPv4 address carried inside an IPv6 value is the IPv4 address. */
    @Test
    fun `a mapped IPv4 address is unwrapped`() {
        assertEquals("203.0.113.7", ClientDetails.normalise("::ffff:203.0.113.7"))
    }

    /** A label is better than a blank, even when it is in a shape this does not recognise. */
    @Test
    fun `something unparseable is returned untouched`() {
        assertEquals("not-an-address", ClientDetails.normalise("not-an-address"))
    }
}
