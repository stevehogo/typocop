<?php
// Signal C (no-progress): an override-shadowing infinite recursion whose parent
// lives in an un-scanned vendor/, so there is no `overrides` edge and arity
// matches (0 == 0). Only the no-progress signal can see it.
class Ipn {
  public function _registerPaymentFailure() {
    try {
      $this->_registerPaymentFailure();
    } catch (\Exception $e) {
      throw $e;
    }
  }
}
